import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import sqlite3
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'app'))
from ffmpeg_progress import progress_fields, run_media_process
from pipeline_events import PipelineStopped, progress_context
import upload_to_youtube as pipeline


class PipelineProgressTests(unittest.TestCase):
    def test_failures_distinguish_authorization_network_quota_and_missing_dependencies(self):
        from pipeline_failure import describe_failure, safe_detail, parse_failure, emit_failure, PipelineFailure
        for message, code in [('invalid_grant: Token has been expired or revoked', 'AUTH_INVALID'),
                              ('invalid_client', 'AUTH_CLIENT_INVALID'), ('ProxyError: timed out', 'NETWORK_ERROR'),
                              ('quotaExceeded', 'QUOTA_EXCEEDED'), ('No module named socks', 'DEPENDENCY_MISSING')]:
            self.assertEqual(describe_failure(message)['code'], code)
        sanitized = safe_detail('Bearer SECRET1 {"refresh_token":"SECRET2", "client_secret":"SECRET3"} https://example.com?token=SECRET4')
        self.assertNotIn('SECRET', sanitized)
        self.assertIsNone(parse_failure('DRAMAVOX_FAILURE {"code":123}'))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            emit_failure(PipelineFailure(describe_failure('invalid_grant')))
        self.assertEqual(parse_failure(output.getvalue())['code'], 'AUTH_INVALID')

    def test_processing_without_upload_does_not_require_an_authorized_account(self):
        import web_service
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.mp4'
            source.write_bytes(b'input')
            store = web_service.Store(root / 'data')
            task = store.create({'resourceName': 'local-only', 'shareText': 'https://pan.baidu.com/s/test',
                                 'mode': 'mute', 'noUpload': True})
            store.update(task['id'], local_path=str(source))
            worker = web_service.Worker(store)
            with patch.object(web_service, 'test_authorization') as authorization, patch.object(worker, 'run_pipeline') as run:
                worker.execute(store.claim())
            authorization.assert_not_called()
            run.assert_called_once()
            self.assertEqual(store.get(task['id'])['status'], 'completed')

    def test_expired_authorization_fails_before_download_and_preserves_cached_video(self):
        import web_service
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = web_service.Store(root / 'data')
            task = store.create({'resourceName': 'auth-test', 'shareText': 'https://pan.baidu.com/s/test', 'mode': 'mute'})
            cached = root / 'finished.mp4'
            cached.write_bytes(b'keep-processed-video')
            store.update(task['id'], local_path=str(root))
            worker = web_service.Worker(store)
            worker.download = Mock(side_effect=AssertionError('download must not start'))
            worker.run_pipeline = Mock(side_effect=AssertionError('pipeline must not start'))
            with patch.object(web_service, 'test_authorization', return_value={'status': 'invalid', 'message': '账号授权已失效（invalid_grant）'}):
                worker.execute(store.claim())
            saved = store.get(task['id'])
            self.assertEqual(saved['status'], 'failed')
            self.assertEqual(saved['progress']['failure']['code'], 'AUTH_INVALID')
            self.assertIn('账号管理', saved['progress']['failure']['action'])
            self.assertTrue(cached.exists())
            worker.download.assert_not_called()
            worker.run_pipeline.assert_not_called()

    def test_process_exit_keeps_specific_failure_instead_of_only_exit_code(self):
        import web_service
        from pipeline_failure import PipelineFailure
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'app').mkdir()
            (root / 'app' / 'upload_to_youtube.py').write_text(
                "import sys,json\n"
                "print('DRAMAVOX_EVENT '+json.dumps({'stage':'authorizing','percent':None}),flush=True)\n"
                "print('invalid_grant: Token has been expired or revoked',flush=True)\n"
                "sys.exit(1)\n", encoding='utf-8')
            store = web_service.Store(root / 'data')
            task = store.create({'resourceName': 'exit-test', 'shareText': 'https://pan.baidu.com/s/test', 'mode': 'mute', 'noUpload': True})
            store.update(task['id'], status='processing')
            with patch.object(web_service, 'ROOT', root), self.assertRaises(PipelineFailure) as raised:
                web_service.Worker(store).run_pipeline(store.get(task['id']), root)
            self.assertEqual(raised.exception.failure['code'], 'AUTH_INVALID')
            self.assertEqual(raised.exception.failure['exitCode'], 1)
            self.assertEqual(raised.exception.failure['stage'], 'authorizing')
            self.assertNotIn('下方', str(raised.exception))

    def test_historical_errors_are_classified_for_lists_without_exposing_logs(self):
        import web_service
        row = dict(status='failed', error='分离 / 上传程序退出，代码 1。请查看下方执行日志后重试',
                   payload=json.dumps({'shareText': 'private-share'}), progress=json.dumps({'stage': 'uploading'}),
                   timings='{}', result=None,
                   logs='开始 / 恢复任务\ninvalid_grant\n开始 / 恢复任务\nquotaExceeded')
        saved = web_service.Store.decode(row, detail=False)
        self.assertEqual(saved['progress']['failure']['code'], 'QUOTA_EXCEEDED')
        self.assertNotIn('logs', saved)
        self.assertNotIn('shareText', saved['payload'])
        self.assertNotIn('下方', saved['error'])

    def test_resumed_pipeline_has_a_stage_and_closed_stdin_before_child_output(self):
        import web_service
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'app').mkdir()
            # An actual child reads stdin; an inherited bridge input would block it.
            (root / 'app' / 'upload_to_youtube.py').write_text(
                "import sys,json\n"
                "assert sys.stdin.read() == ''\n"
                "print('child-started', flush=True)\n"
                "print('DRAMAVOX_EVENT '+json.dumps({'stage':'scanning','message':'scan resumed materials'}),flush=True)\n",
                encoding='utf-8')
            store = web_service.Store(root / 'data')
            task = store.create({'resourceName': 'resume-test', 'shareText': 'https://pan.baidu.com/s/test',
                                 'mode': 'mute', 'noUpload': True})
            store.update(task['id'], status='processing', local_path=str(root),
                         progress={'stage': 'separating', 'percent': 50})
            store.action(task['id'], 'pause')
            # A fresh service preserves a paused task until the explicit resume.
            store = web_service.Store(root / 'data')
            store.recover()
            self.assertEqual(store.get(task['id'])['status'], 'paused')
            store.action(task['id'], 'resume')
            task = store.claim()
            self.assertEqual(task['local_path'], str(root))
            store.update(task['id'], status='processing')
            worker = web_service.Worker(store)
            original_popen = subprocess.Popen
            observed = []
            def launch(*args, **kwargs):
                observed.append(store.get(task['id'])['progress'])
                self.assertEqual(kwargs.get('stdin'), subprocess.DEVNULL)
                return original_popen(*args, **kwargs)
            with patch.object(web_service, 'ROOT', root), patch.object(web_service.subprocess, 'Popen', side_effect=launch):
                worker.run_pipeline(task, root)
            self.assertEqual(observed[0]['stage'], 'preparing')
            self.assertTrue(observed[0]['message'])
            saved = store.get(task['id'])
            self.assertEqual(saved['progress']['stage'], 'scanning')
            self.assertIn('child-started', saved['logs'])

    def test_preparation_and_scan_events_are_not_dropped(self):
        from pipeline_events import parse_line
        for stage in ('preparing', 'scanning'):
            event = {'stage': stage, 'message': 'resuming task', 'percent': None}
            self.assertEqual(parse_line('DRAMAVOX_EVENT ' + json.dumps(event)), event)

    def test_task_database_connections_close_and_rollback(self):
        from web_service import Store
        with tempfile.TemporaryDirectory() as directory:
            store = Store(directory)
            with store.connect() as db:
                db.execute("INSERT OR REPLACE INTO settings VALUES (1, ?)", (json.dumps({'paused': True}),))
            with self.assertRaises(sqlite3.ProgrammingError):
                db.execute('SELECT 1')
            with self.assertRaises(RuntimeError), store.connect() as db:
                db.execute("UPDATE settings SET value=? WHERE id=1", (json.dumps({'paused': False}),))
                raise RuntimeError('rollback')
            self.assertTrue(store.settings()['paused'])
    def test_real_media_time_percentage_and_eta(self):
        fields = progress_fields({'out_time_us': '50000000', 'speed': '2.0x', 'frame': '1500'}, 200, 25)
        self.assertEqual(fields['percent'], 25)
        self.assertEqual(fields['processedSeconds'], 50)
        self.assertEqual(fields['etaText'], '00:01:15')
        self.assertIsNone(progress_fields({}, None, 60)['percent'])
        self.assertNotIn('etaText', progress_fields({'speed': 'N/A'}, 100, 60))

    def test_file_progress_is_combined_with_completed_items(self):
        events = []
        script = "print('out_time_us=1000000',flush=True);print('speed=2x',flush=True);print('progress=end',flush=True)"
        with progress_context(stage='normalizing', completedItems=1, totalItems=3):
            result = run_media_process([sys.executable, '-u', '-c', script], duration=2,
                                       notify=lambda stage, **fields: events.append((stage, fields)))
        self.assertEqual(result.returncode, 0)
        self.assertTrue(any(fields['percent'] == 50 for _, fields in events))
        self.assertEqual(events[-1][1]['percent'], 66.7)
        self.assertEqual(events[-1][1]['completedItems'], 2)

    def test_silent_process_remains_cancellable(self):
        started = time.monotonic()
        def stop_check():
            if time.monotonic() - started > .15:
                raise PipelineStopped('test pause')
        with self.assertRaises(PipelineStopped):
            run_media_process([sys.executable, '-c', 'import time;time.sleep(30)'], stop_check=stop_check)
        self.assertLess(time.monotonic() - started, 4)

    def test_stderr_is_drained_and_bounded_without_losing_full_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / 'ffmpeg.log'
            result = run_media_process([sys.executable, '-c', "import sys;sys.stderr.write('x'*40000);sys.exit(3)"], log_path=log)
            self.assertEqual(result.returncode, 3)
            self.assertEqual(len(result.stderr), 8000)
            self.assertEqual(log.stat().st_size, 40000)

    def test_stdin_is_closed_for_background_children(self):
        result = run_media_process([sys.executable, '-c', "import sys;sys.exit(0 if sys.stdin.read()=='' else 1)"])
        self.assertEqual(result.returncode, 0)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_real_concat_and_full_decode_publish_progress(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'episode.mp4'
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
                            'testsrc2=s=160x96:r=25', '-f', 'lavfi', '-i', 'sine=sample_rate=44100',
                            '-t', '0.6', '-c:v', 'libx264', '-threads', '1', '-c:a', 'aac', str(source)],
                           check=True, capture_output=True, timeout=20)
            text = io.StringIO()
            with patch.dict(os.environ, {'DRAMAVOX_EVENTS': '1'}), contextlib.redirect_stdout(text):
                pipeline.merge_videos([source, source], root / 'merged.mp4', root / 'work')
            events = [json.loads(line.split(' ', 1)[1]) for line in text.getvalue().splitlines() if line.startswith('DRAMAVOX_EVENT ')]
            for stage in ['probing', 'merging', 'validating', 'checking_timestamps']:
                self.assertTrue(any(event['stage'] == stage and event.get('percent') == 100 for event in events), stage)
            self.assertTrue((root / 'merged.mp4').stat().st_size > 0)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
    def test_corrupt_video_validation_is_reported_as_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'broken.mp4'
            source.write_bytes(b'not a video')
            text = io.StringIO()
            with patch.dict(os.environ, {'DRAMAVOX_EVENTS': '1'}), contextlib.redirect_stdout(text):
                self.assertFalse(pipeline._verify_video_decode(source))
            events = [json.loads(line.split(' ', 1)[1]) for line in text.getvalue().splitlines() if line.startswith('DRAMAVOX_EVENT ')]
            finish = next(event for event in events if event.get('timing') == 'finish')
            self.assertEqual(finish['outcome'], 'failed')
            self.assertIn('[失败] 校验成片', text.getvalue())


if __name__ == '__main__':
    unittest.main()
