import os
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from task_workspaces import TaskWorkspaces, task_lease, RETAIN_SECONDS, MARKER


class Store:
    def __init__(self, root):
        self.path = root / 'tasks.sqlite3'
        with self.connect() as db:
            db.execute('CREATE TABLE tasks(id TEXT PRIMARY KEY,status TEXT,updated TEXT,local_path TEXT,'
                       'remote_id TEXT,remote_base TEXT,remote_paused INTEGER,progress TEXT,download_generation TEXT)')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.store = Store(self.root)
        self.workspaces = TaskWorkspaces(self.store, self.root)
        self.source = self.root / 'materials' / 'original.mp4'
        self.source.parent.mkdir()
        self.source.write_bytes(b'original')
        self.credential = self.root / 'data' / 'credentials' / 'token.json'
        self.credential.parent.mkdir(parents=True)
        self.credential.write_text('keep-token')
        self.runtime = self.root / 'python-env' / 'bin' / 'python'
        self.runtime.parent.mkdir(parents=True)
        self.runtime.write_text('keep-runtime')

    def tearDown(self):
        self.temp.cleanup()

    def add(self, status='completed', age=0):
        key = str(uuid.uuid4())
        with self.store.connect() as db:
            db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)',
                       (key, 'processing', datetime.now().isoformat(), str(self.source), 'remote', 'base', 1, '{}', None))
        target = self.workspaces.prepare(key)
        (target / 'cache').mkdir()
        (target / 'cache' / 'audio.wav').write_bytes(b'cache' * 1024)
        self.status(key, status, age)
        self.age(target, age)
        return key, target

    def status(self, key, status, age=0):
        with self.store.connect() as db:
            db.execute('UPDATE tasks SET status=?,updated=? WHERE id=?',
                       (status, datetime.fromtimestamp(time.time() - age).isoformat(), key))

    def age(self, path, age):
        at = time.time() - age
        for item in reversed([path, *path.rglob('*')]):
            os.utime(item, (at, at))

    def assert_protected(self):
        self.assertEqual(self.source.read_bytes(), b'original')
        self.assertEqual(self.credential.read_text(), 'keep-token')
        self.assertEqual(self.runtime.read_text(), 'keep-runtime')

    def test_success_is_cleaned_immediately_without_deleting_materials(self):
        key, target = self.add()
        result = self.workspaces.clean_task(key)
        self.assertGreater(result['removedBytes'], 0)
        self.assertFalse(target.exists())
        self.assertFalse(list(self.workspaces.trash.iterdir()))
        self.assert_protected()

    def test_active_and_paused_tasks_are_protected_even_when_old(self):
        for state in ('processing', 'uploading', 'downloading', 'queued', 'paused'):
            key, target = self.add(state, RETAIN_SECONDS * 3)
            self.assertEqual(self.workspaces.clean_task(key, pressure=True)['removedBytes'], 0)
            self.assertTrue((target / 'cache' / 'audio.wav').exists())
        self.assert_protected()

    def test_failed_tasks_expire_after_one_day_and_retry_gets_fresh_download(self):
        young, young_path = self.add('failed', RETAIN_SECONDS - 60)
        old, old_path = self.add('failed', RETAIN_SECONDS + 60)
        self.assertEqual(self.workspaces.clean_task(young)['removedBytes'], 0)
        self.assertTrue(young_path.exists())
        self.assertGreater(self.workspaces.clean_task(old)['removedBytes'], 0)
        self.assertFalse(old_path.exists())
        with self.store.connect() as db:
            task = db.execute('SELECT * FROM tasks WHERE id=?', (old,)).fetchone()
            self.assertIsNone(task['local_path'])
            self.assertIsNone(task['remote_id'])
            self.assertIsNone(task['remote_base'])
            self.assertIsNone(task['progress'])
            self.assertEqual(len(task['download_generation']), 32)
            self.assertEqual(task['status'], 'failed')
        self.status(old, 'processing')
        self.assertTrue(self.workspaces.prepare(old).is_dir())
        self.assert_protected()

    def test_live_pipeline_lease_blocks_deletion(self):
        key, target = self.add()
        with task_lease(self.root, key):
            result = self.workspaces.clean_task(key)
            self.assertEqual(result['removedBytes'], 0)
            self.assertTrue(result['errors'])
            self.assertTrue(target.exists())
        self.assertGreater(self.workspaces.clean_task(key)['removedBytes'], 0)

    def test_symlinked_file_blocks_entire_cleanup_before_deleting_any_cache(self):
        key, target = self.add()
        try:
            (target / 'outside').symlink_to(self.source.parent, target_is_directory=True)
        except OSError:
            self.skipTest('symlinks unavailable')
        result = self.workspaces.clean_task(key)
        self.assertTrue(result['errors'])
        self.assertTrue((target / 'cache' / 'audio.wav').exists())
        self.assert_protected()

    def test_symlinked_task_and_work_roots_are_rejected(self):
        key, target = self.add()
        shutil.rmtree(target)
        try:
            target.symlink_to(self.source.parent, target_is_directory=True)
        except OSError:
            self.skipTest('symlinks unavailable')
        self.assertTrue(self.workspaces.clean_task(key)['errors'])
        target.unlink()
        shutil.rmtree(self.root / 'work')
        (self.root / 'work').symlink_to(self.source.parent, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.workspaces.clean_task(key)
        self.assert_protected()

    def test_missing_marker_and_path_traversal_are_rejected(self):
        key, target = self.add()
        (target / MARKER).unlink()
        self.assertTrue(self.workspaces.clean_task(key)['errors'])
        with self.assertRaises(ValueError):
            self.workspaces.clean_task('../../materials')
        self.assert_protected()

    def test_interrupted_trash_cleanup_is_retried_even_after_marker_was_removed(self):
        key, target = self.add()
        def interrupted(directory):
            (directory / MARKER).unlink()
            raise OSError('simulated shutdown')
        with patch('task_workspaces.shutil.rmtree', side_effect=interrupted):
            self.assertTrue(self.workspaces.clean_task(key)['errors'])
        self.assertFalse(target.exists())
        self.assertGreater(self.workspaces.scan(clean=True)['removedBytes'], 0)
        self.assertFalse(list(self.workspaces.trash.iterdir()))
        self.assert_protected()

    def test_unowned_work_directories_are_not_deleted(self):
        target = self.root / 'work' / 'user-backup'
        target.mkdir(parents=True)
        (target / 'original.mp4').write_text('keep')
        self.age(target, RETAIN_SECONDS * 3)
        self.workspaces.scan(clean=True)
        self.assertTrue((target / 'original.mp4').exists())

    def test_low_space_prevents_processing(self):
        with patch('task_workspaces.shutil.disk_usage', return_value=SimpleNamespace(free=1)):
            with self.assertRaisesRegex(RuntimeError, '空间不足'):
                self.workspaces.ensure_space()
        self.assert_protected()

    def test_processed_video_is_created_in_task_work_not_material_directory(self):
        import upload_to_youtube as pipeline
        key, target = self.add('processing')
        def write(path):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'generated')
        args = SimpleNamespace(fast=False, force=False, temporary_outputs=True)
        with patch.object(pipeline, 'probe_readable', return_value=True), \
             patch.object(pipeline, 'extract_audio', side_effect=lambda source, output: write(output)), \
             patch.object(pipeline, 'separate_vocals', side_effect=lambda wav, output, fast: write(output / 'htdemucs' / wav.stem / 'vocals.wav')), \
             patch.object(pipeline, 'remux_video', side_effect=lambda source, vocals, output: write(output)):
            output = pipeline.process_video(self.source, args, target)
        self.assertTrue(output.is_relative_to(target))
        self.assertEqual(list(self.source.parent.iterdir()), [self.source])
        self.assert_protected()

    def test_worker_cleans_only_after_pipeline_has_completed(self):
        import desktop_bridge
        import web_service
        queue = web_service.Store(self.root / 'data')
        task = queue.create({'resourceName': 'safe-task', 'shareText': 'https://pan.baidu.com/s/test', 'noUpload': True})
        queue.update(task['id'], local_path=str(self.source))
        target = self.root / 'work' / 'tasks' / task['id']

        def pipeline(worker, current, source):
            workspace = worker.workspaces.prepare(current['id'])
            (workspace / 'output.mp4').write_bytes(b'processed')
            self.assertTrue((workspace / 'output.mp4').exists())

        with patch.object(web_service, 'ROOT', self.root), \
             patch.object(web_service.Worker, 'run_pipeline', pipeline), \
             patch('desktop_bridge.shutil.disk_usage', return_value=SimpleNamespace(free=10 * 1024**3)):
            worker = desktop_bridge.DesktopWorker(queue)
            worker.execute(queue.get(task['id']))
        self.assertEqual(queue.get(task['id'])['status'], 'completed')
        self.assertFalse(target.exists())
        self.assert_protected()

    def test_expired_failed_retry_creates_a_new_download_request(self):
        import web_service
        queue = web_service.Store(self.root / 'data')
        task = queue.create({'resourceName': 'retry-task', 'shareText': 'https://pan.baidu.com/s/test', 'noUpload': True})
        queue.update(task['id'], status='processing', local_path=str(self.source), remote_id='old-download')
        workspace = TaskWorkspaces(queue, self.root).prepare(task['id'])
        (workspace / 'cache.wav').write_bytes(b'cache')
        queue.update(task['id'], status='failed')
        with queue.connect() as db:
            db.execute('UPDATE tasks SET updated=? WHERE id=?',
                       (datetime.fromtimestamp(time.time() - RETAIN_SECONDS - 60).isoformat(), task['id']))
        self.age(workspace, RETAIN_SECONDS + 60)
        retried = queue.action(task['id'], 'retry')
        self.assertFalse(workspace.exists())
        requests = []
        source = self.source

        class Client:
            def call(self, route, payload=None):
                requests.append((route, payload))
                return {'taskId': 'new-download', 'status': 'completed', 'result': {'localPath': str(source)}}

        worker = web_service.Worker(queue, client_factory=lambda base: Client())
        self.assertEqual(worker.download(retried), self.source)
        self.assertEqual(requests[0][0], '/baidu-netdisk/downloads')
        self.assertTrue(requests[0][1]['requestId'].startswith(task['id'] + ':'))
        self.assertEqual(queue.get(task['id'])['remote_id'], 'new-download')
        self.assert_protected()

    def test_base_worker_cleanup_also_preserves_original_materials(self):
        import web_service
        queue = web_service.Store(self.root / 'data')
        task = queue.create({'resourceName': 'base-worker', 'shareText': 'https://pan.baidu.com/s/test', 'noUpload': True})
        queue.update(task['id'], status='processing', local_path=str(self.source))
        workspace = TaskWorkspaces(queue, self.root).prepare(task['id'])
        (workspace / 'output.mp4').write_bytes(b'cache')
        queue.update(task['id'], status='completed')
        with patch.object(web_service, 'ROOT', self.root):
            web_service.Worker(queue).cleanup_finished_task(queue.get(task['id']))
        self.assertFalse(workspace.exists())
        self.assert_protected()


if __name__ == '__main__':
    unittest.main()
