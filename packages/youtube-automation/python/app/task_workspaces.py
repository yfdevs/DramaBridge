"""Isolated task scratch space; never deletes input materials or runtime data."""
import os
import re
import shutil
import stat
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

RETAIN_SECONDS = 24 * 3600
MIN_FREE = 2 * 1024**3
CRITICAL_FREE = 512 * 1024**2
MARKER = '.dramabridge-task'


def task_key(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('无效的任务临时目录编号')
    return value


def linked(path):
    for item in (path, *path.parents):
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
            return True
    return False


def inspect_tree(path):
    if linked(path):
        raise ValueError('临时目录包含链接，已跳过清理')
    size = 0
    newest = path.stat().st_mtime
    def scan_error(error):
        raise error
    for base, directories, files in os.walk(path, followlinks=False, onerror=scan_error):
        parent = Path(base)
        newest = max(newest, parent.stat().st_mtime)
        for name in directories + files:
            item = parent / name
            if linked(item):
                raise ValueError('临时目录包含链接，已跳过清理')
            info = item.stat()
            newest = max(newest, info.st_mtime)
            if item.is_file():
                size += info.st_size
    return size, newest


@contextmanager
def task_lease(root, task_id, wait=False):
    key = task_key(task_id)
    directory = Path(root).resolve() / 'data' / 'work-locks'
    if linked(directory):
        raise ValueError('任务锁目录不能是链接')
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / (key + '.lock')
    if linked(target):
        raise ValueError('任务锁文件不能是链接')
    stream = target.open('a+b')
    if stream.tell() == 0:
        stream.write(b'0')
        stream.flush()
    deadline = time.monotonic() + (30 if wait else 0)
    acquired = False
    try:
        while True:
            stream.seek(0)
            try:
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError('任务临时目录仍在使用，已跳过清理') from None
                time.sleep(.1)
        yield
    finally:
        if acquired:
            stream.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_UN)
        stream.close()


class TaskWorkspaces:
    def __init__(self, store, root):
        self.store = store
        self.root = Path(root).resolve()
        self.work = self.root / 'work'
        self.tasks = self.work / 'tasks'
        self.trash = self.work / '.cleanup-trash'
        self.stop = threading.Event()
        info = self.root.stat()
        self.identity = (info.st_dev, info.st_ino)

    def check_root(self):
        info = self.root.stat()
        if linked(self.root) or (info.st_dev, info.st_ino) != self.identity:
            raise ValueError('运行目录已变化，停止清理')
        for directory in (self.work, self.tasks, self.trash):
            if linked(directory):
                raise ValueError('工作目录不能是链接')

    def path(self, task_id):
        self.check_root()
        return self.tasks / task_key(task_id)

    def validate(self, directory, task_id):
        self.check_root()
        if directory.parent not in (self.tasks, self.trash) or linked(directory):
            raise ValueError('拒绝清理任务目录以外的路径')
        marker = directory / MARKER
        key = task_key(task_id)
        if directory.parent == self.trash:
            owner = self.trash / (directory.name + '.owner')
            info = directory.stat()
            expected = f'{key}\n{info.st_dev}\n{info.st_ino}'
            if not linked(owner) and owner.stat().st_size <= 128 and owner.read_text(encoding='utf-8') == expected:
                return
        if linked(marker) or marker.stat().st_size != len(key) or marker.read_text(encoding='utf-8') != key:
            raise ValueError('临时目录标识不匹配，已跳过清理')

    def prepare(self, task_id):
        target = self.path(task_id)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            task = db.execute('SELECT status FROM tasks WHERE id=?', (task_id,)).fetchone()
            if not task or task['status'] not in ('processing', 'uploading'):
                raise ValueError('任务不在处理状态，不能创建临时目录')
            self.tasks.mkdir(parents=True, exist_ok=True)
            try:
                target.mkdir()
            except FileExistsError:
                self.validate(target, task_id)
                inspect_tree(target)
            else:
                (target / MARKER).write_text(task_id, encoding='utf-8')
        return target

    def eligible(self, task, directory, pressure=False):
        if task and task['status'] in ('completed', 'deleted'):
            return True
        if task and task['status'] not in ('failed', 'cancelled'):
            return False
        age = time.time() - directory.stat().st_mtime
        if task:
            age = time.time() - datetime.fromisoformat(task['updated']).timestamp()
        return (pressure and task is not None) or age > RETAIN_SECONDS

    def clean_task(self, task_id, directory=None, pressure=False):
        key = task_key(task_id)
        target = directory or self.path(key)
        if not target.exists() and not target.is_symlink():
            return {'removedBytes': 0, 'errors': []}
        try:
            with task_lease(self.root, key):
                self.validate(target, key)
                with self.store.connect() as db:
                    db.execute('BEGIN IMMEDIATE')
                    task = db.execute('SELECT id,status,updated FROM tasks WHERE id=?', (key,)).fetchone()
                    if not self.eligible(task, target, pressure):
                        return {'removedBytes': 0, 'errors': []}
                    _, newest = inspect_tree(target)
                    if not task and time.time() - newest <= RETAIN_SECONDS:
                        return {'removedBytes': 0, 'errors': []}
                    if target.parent == self.tasks:
                        self.trash.mkdir(parents=True, exist_ok=True)
                        destination = self.trash / (key + '--' + uuid.uuid4().hex)
                        info = target.stat()
                        owner = self.trash / (destination.name + '.owner')
                        with owner.open('x', encoding='utf-8') as stream:
                            stream.write(f'{key}\n{info.st_dev}\n{info.st_ino}')
                        target.rename(destination)
                        target = destination
                    if task and task['status'] in ('failed', 'cancelled'):
                        # A later retry must create a fresh download request, not
                        # resume the cleaned processing/download record.
                        db.execute('UPDATE tasks SET local_path=NULL,remote_id=NULL,remote_base=NULL,'
                                   'remote_paused=0,progress=NULL,download_generation=? WHERE id=?',
                                   (uuid.uuid4().hex, key))
                # Re-check after the atomic rename. Shared sources are never candidates.
                self.validate(target, key)
                size, _ = inspect_tree(target)
                shutil.rmtree(target)
                owner = self.trash / (target.name + '.owner')
                if not linked(owner):
                    owner.unlink(missing_ok=True)
                return {'removedBytes': size, 'errors': []}
        except (OSError, ValueError, RuntimeError) as error:
            return {'removedBytes': 0, 'errors': [str(error)]}

    def scan(self, clean=False):
        self.check_root()
        result = {'removedBytes': 0, 'errors': []}
        pressure = shutil.disk_usage(self.root).free < MIN_FREE
        for parent in (self.tasks, self.trash):
            if not parent.exists():
                continue
            for target in list(parent.iterdir()):
                try:
                    if parent == self.trash and re.fullmatch(r'[a-f0-9-]{36}--[a-f0-9]{32}\.owner', target.name):
                        destination = self.trash / target.name[:-6]
                        key = task_key(destination.name.split('--', 1)[0])
                        if not destination.exists() and not linked(target) and target.stat().st_size <= 128 and time.time() - target.stat().st_mtime > RETAIN_SECONDS:
                            values = target.read_text(encoding='utf-8').splitlines()
                            if len(values) == 3 and values[0] == key and all(value.isdigit() for value in values[1:]):
                                target.unlink()
                        continue
                    key = target.name.split('--', 1)[0] if parent == self.trash else target.name
                    task_key(key)
                    if parent == self.trash and not re.fullmatch(re.escape(key) + r'--[a-f0-9]{32}', target.name):
                        continue
                    if clean:
                        removed = self.clean_task(key, target, pressure)
                        result['removedBytes'] += removed['removedBytes']
                        result['errors'].extend(removed['errors'])
                except (OSError, ValueError) as error:
                    result['errors'].append(str(error))
        return result

    def loop(self):
        while not self.stop.is_set():
            try:
                result = self.scan(clean=True)
                if result['removedBytes']:
                    print(f"临时文件清理释放 {result['removedBytes'] / 1024**2:.1f} MB", flush=True)
                for error in result['errors']:
                    print('临时文件清理跳过：' + error, flush=True)
            except Exception as error:
                print('临时文件清理失败：' + str(error), flush=True)
            self.stop.wait(300)

    def ensure_space(self, required=MIN_FREE):
        self.check_root()
        if shutil.disk_usage(self.root).free < required:
            raise RuntimeError('磁盘可用空间不足，请先释放空间后重试')
