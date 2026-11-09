"""Task-aware storage accounting and conservative retention enforcement."""
import hashlib
import os
import threading
import time
from datetime import datetime
from pathlib import Path

INTERVAL = 3 * 3600
MIN_AGE = 5 * 3600
FAILED_AGE = 2 * 86400


def linked(path):
    return any(p.is_symlink() or (hasattr(p, 'is_junction') and p.is_junction())
               for p in (path, *path.parents))


def inventory(path):
    """Never follow symlinks/junctions, including ancestor redirects."""
    if linked(path):
        raise ValueError(f'跳过链接目录：{path}')
    files, directories = [], []
    if not path.exists():
        return files, directories, 0
    newest = path.stat().st_mtime
    if path.is_file():
        return [(path, path.stat().st_size)], [], newest
    def scan_error(error):
        raise error
    for base, dirs, names in os.walk(path, followlinks=False, onerror=scan_error):
        base = Path(base)
        directories.append(base)
        newest = max(newest, base.stat().st_mtime)
        for name in dirs + names:
            child = base / name
            if linked(child):
                raise ValueError(f'跳过包含链接的目录：{path}')
            info = child.stat()
            newest = max(newest, info.st_mtime)
            if child.is_file():
                files.append((child, info.st_size))
    return files, directories, newest


class StorageCleanup:
    def __init__(self, store, root):
        self.store, self.root = store, Path(root).resolve()
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.last_run = None
        self.next_run = None
        self.last_result = None

    def clean_task(self, task_id):
        """Remove only resources attributable to one terminal task."""
        task = self.store.get(task_id)
        if not task or not task.get('local_path'):
            return {'removedBytes': 0, 'errors': []}
        source = Path(os.path.abspath(task['local_path']))
        # Reuse all path safety checks and shared-source protection in scan.
        return self.scan(clean=True, task_id=task_id)

    def scan(self, clean=False, task_id=None):
        # Serialize with claim/retry/create for the entire eligibility/deletion window.
        with self.lock, self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            tasks = [dict(row) for row in db.execute('SELECT id,status,updated,local_path FROM tasks')]
            current = time.time()
            def eligible(task):
                if task_id is not None:
                    return task['id'] == task_id
                age = current - datetime.fromisoformat(task['updated']).timestamp()
                return (task['status'] in {'completed', 'deleted'} and age > MIN_AGE or
                        task['status'] == 'cancelled' and age > FAILED_AGE)
            # Completed tasks no longer use shared caches; their fresh files remain
            # protected by each cache tree's own modification time.
            protected = any(t['status'] not in {'completed', 'deleted'} and not eligible(t)
                            for t in tasks)
            groups = {}
            for task in tasks:
                if task['local_path']:
                    path = Path(os.path.abspath(task['local_path']))
                    groups.setdefault(path, []).append(task)
            # Consolidate overlapping source trees; every reference must permit deletion.
            sources = []
            for path in sorted(groups, key=lambda p: len(p.parts)):
                parent = next((p for p, refs in sources if path.is_relative_to(p)), None)
                if parent is not None:
                    next(refs for p, refs in sources if p == parent).extend(groups[path])
                else:
                    sources.append((path, list(groups[path])))
            result = {'work': {'bytes': 0, 'eligibleBytes': 0},
                      'materials': {'bytes': 0, 'eligibleBytes': 0},
                      'removedBytes': 0, 'removedFiles': 0, 'errors': []}
            work = self.root / 'work'
            candidates = []
            if work.exists() and not linked(work):
                for category in work.iterdir():
                    if category.is_dir() and not linked(category):
                        candidates.extend(('work', entry, not protected) for entry in category.iterdir())
                    else:
                        candidates.append(('work', category, not protected))
            if task_id is not None:
                target = next((t for t in tasks if t['id'] == task_id), None)
                keys = set()
                if target and target['local_path']:
                    source = Path(os.path.abspath(target['local_path']))
                    # A shared source must remain intact while any other task references it.
                    shared = any(t['id'] != task_id and t['local_path'] and
                                 (source.is_relative_to(Path(os.path.abspath(t['local_path']))) or
                                  Path(os.path.abspath(t['local_path'])).is_relative_to(source)) for t in tasks)
                    if not shared and not linked(source):
                        paths = [source]
                        if source.is_dir():
                            paths.extend(f for f, _ in inventory(source)[0])
                        def key(p):
                            return hashlib.sha256(str(p.resolve()).encode('utf-8')).hexdigest()[:16]
                        keys.update(key(p) for p in paths)
                        merged = work / 'merge' / key(source) / '全集_原片.mp4'
                        keys.add(key(merged))
                        keys.add(key(work / 'merge' / key(merged)))
                candidates = [(kind, path, path.name in keys) for kind, path, _ in candidates]
            for path, refs in sources:
                # Reject broad/system/project paths rather than treating them as materials.
                unsafe = (path == Path(path.anchor) or self.root.is_relative_to(path) or
                          any(path.is_relative_to(self.root / name) for name in
                              ('app', 'data', 'web', 'scripts', 'tests', '.venv', 'work', '.git', 'release', 'requirements')) or
                          Path.home().is_relative_to(path) or len(path.parts) < 3)
                candidates.append(('materials', path, not unsafe and all(eligible(t) for t in refs)))
            for kind, path, allowed in candidates:
                try:
                    files, directories, newest = inventory(path)
                    size = sum(n for _, n in files)
                    result[kind]['bytes'] += size
                    # Overlapping references from other trees also protect their resources.
                    if kind == 'materials':
                        allowed = allowed and all(eligible(t) for p, refs in sources
                            if path.is_relative_to(p) or p.is_relative_to(path) for t in refs)
                    if not allowed or (task_id is None and current - newest <= MIN_AGE):
                        continue
                    result[kind]['eligibleBytes'] += size
                    if clean:
                        # Resolve and check every target immediately before unlinking.
                        for file, size in files:
                            if linked(file) or not file.resolve().is_relative_to(path.resolve()):
                                raise ValueError(f'资源路径发生变化：{file}')
                            if task_id is None and time.time() - file.stat().st_mtime <= MIN_AGE:
                                raise ValueError(f'资源刚刚更新，已停止清理：{file}')
                            file.unlink()
                            result['removedBytes'] += size
                            result['removedFiles'] += 1
                        for directory in reversed(directories):
                            if directory != work:
                                directory.rmdir()
                except (OSError, ValueError) as exc:
                    result['errors'].append(str(exc))
            result['workProtected'] = protected
            if clean:
                self.last_run = current
                self.last_result = result.copy()
            return {**result, 'lastRun': self.last_run, 'nextRun': self.next_run,
                    'lastResult': self.last_result, 'intervalSeconds': INTERVAL}

    def loop(self):
        while not self.stop.is_set():
            self.next_run = time.time() + INTERVAL
            try:
                self.scan(clean=True)
            except Exception as exc:
                self.last_result = {'errors': [str(exc)]}
                print(f'资源清理失败：{exc}', flush=True)
            if self.stop.wait(max(0, self.next_run - time.time())):
                break
