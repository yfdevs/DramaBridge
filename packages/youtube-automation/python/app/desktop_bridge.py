"""Electron-owned lifecycle/configuration and authenticated loopback API.

Only task records and OAuth credentials are persisted by Python. Business
settings are supplied on stdin and saved through Electron's electron-store.
"""
import hmac
import importlib.util
import json
import shutil
import signal
import subprocess
import sys
import threading
import uuid
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import web_service as vox
from task_workspaces import TaskWorkspaces, MIN_FREE, CRITICAL_FREE

_write_lock = threading.Lock()
_pending_lock = threading.Lock()
_pending = {}


def emit(value):
    with _write_lock:
        try:
            print(json.dumps(value, ensure_ascii=False), flush=True)
        except (BrokenPipeError, OSError):
            pass


def call_parent(kind, payload):
    request_id = uuid.uuid4().hex
    event = threading.Event()
    holder = {}
    with _pending_lock:
        _pending[request_id] = (event, holder)
    try:
        emit({'kind': kind, 'id': request_id, 'payload': payload})
        if not event.wait(35):
            raise RuntimeError('桌面桥接请求超时，请检查 DramaBridge 服务')
        if holder.get('error'):
            raise RuntimeError(holder['error'])
        return holder.get('value')
    finally:
        with _pending_lock:
            _pending.pop(request_id, None)


def media_available(name):
    executable = shutil.which(name)
    if not executable:
        return False
    try:
        return subprocess.run([executable, "-version"], stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=10,
                              **vox.hidden_process_options()).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def environment_status():
    modules = {}
    for name in ('demucs', 'numpy', 'googleapiclient', 'google_auth_oauthlib', 'socks'):
        try:
            modules[name] = importlib.util.find_spec(name) is not None
        except (ImportError, ValueError):
            modules[name] = False
    ffmpeg, ffprobe = media_available('ffmpeg'), media_available('ffprobe')
    return {'python': sys.version.split()[0], 'executable': sys.executable,
            'compatible': sys.version_info >= (3, 10),
            'modules': modules, 'ffmpeg': ffmpeg, 'ffprobe': ffprobe,
            'ready': sys.version_info >= (3, 10) and all(modules.values())
                     and ffmpeg and ffprobe}


class DesktopStore(vox.Store):
    def __init__(self, directory, settings):
        super().__init__(directory)
        self.desktop_settings = {**vox.DEFAULTS, **settings}
        self.settings_lock = threading.RLock()

    def settings(self):
        with self.settings_lock:
            return dict(self.desktop_settings)

    def save_settings(self, values):
        with self.settings_lock:
            # The URL is a compatibility label only: no HTTP Netdisk server is used.
            values = {key: value for key, value in values.items() if key != 'netdiskUrl'}
            persisted = {key: value for key, value in values.items() if key in ('proxy', 'paused')}
            if persisted:
                call_parent('settings', persisted)
            self.desktop_settings.update(values)
            return dict(self.desktop_settings)

    def create(self, body):
        if not environment_status()['ready']:
            raise ValueError('Python 处理环境尚未就绪，请在 YouTube 配置中准备依赖及 FFmpeg')
        return super().create(body)


class DesktopNetdisk:
    def __init__(self, _base=None):
        pass

    def call(self, path, payload=None):
        return call_parent('netdisk', {'path': path, 'body': payload})


class DesktopWorker(vox.Worker):
    def __init__(self, store, client_factory=DesktopNetdisk, poll_seconds=3):
        super().__init__(store, client_factory, poll_seconds)
        self.workspaces = TaskWorkspaces(store, vox.ROOT)
        self.disk_failure = threading.Event()

    def execute(self, task):
        try:
            return super().execute(task)
        finally:
            self.cleanup_finished_task(task)

    def check_pipeline_space(self):
        if self.disk_failure.is_set():
            raise RuntimeError('磁盘空间不足，已停止处理并清理临时文件')
        self.workspaces.ensure_space()

    def run_pipeline(self, task, local):
        self.disk_failure.clear()
        self.workspaces.scan(clean=True)
        self.check_pipeline_space()
        if local.is_dir():
            videos = (file for file in local.rglob('*') if file.suffix.lower() in
                      {'.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'} and not file.is_symlink())
            source_bytes = sum(file.stat().st_size for file in videos if file.is_file())
        else:
            source_bytes = local.stat().st_size
        self.workspaces.ensure_space(max(MIN_FREE, source_bytes * 3))
        stopped = threading.Event()

        def monitor():
            while not stopped.wait(2):
                if shutil.disk_usage(vox.ROOT).free < CRITICAL_FREE:
                    self.disk_failure.set()
                    with self.process_lock:
                        self._terminate_locked()
                    return

        thread = threading.Thread(target=monitor, daemon=True)
        thread.start()
        try:
            return super().run_pipeline(task, local)
        except Exception:
            if self.disk_failure.is_set():
                raise RuntimeError('磁盘空间不足，已停止处理并清理临时文件') from None
            raise
        finally:
            stopped.set()
            thread.join(timeout=3)

    def cleanup_finished_task(self, task):
        try:
            result = self.workspaces.clean_task(task['id'], pressure=shutil.disk_usage(vox.ROOT).free < MIN_FREE)
            if result['removedBytes']:
                self.store.log(task['id'], f"临时文件已清理，释放 {result['removedBytes'] / 1024**2:.1f} MB\n")
            for error in result['errors']:
                self.store.log(task['id'], '临时文件清理跳过：' + error + '\n')
        except Exception as error:
            self.store.log(task['id'], '临时文件清理失败：' + str(error) + '\n')


class DesktopHandler(vox.Handler):
    def trusted_request(self):
        if not super().trusted_request():
            return False
        if urlsplit(self.path).path == '/api/oauth/callback':
            return True  # Original OAuth handler verifies the short-lived state.
        return hmac.compare_digest(self.headers.get('X-DramaBridge-Token', ''), self.server.desktop_token)

    def do_GET(self):
        if urlsplit(self.path).path == '/api/environment':
            if not self.trusted_request():
                self.send_json({'error': '无效的桌面桥接凭据'}, 403)
                return
            self.send_json(environment_status())
        else:
            super().do_GET()


def serve(config):
    root = Path(config['root']).resolve()
    if root != vox.ROOT.resolve():
        raise ValueError('Python 工作目录必须与注入的数据目录一致')
    vox.prepare_layout(root)
    store = DesktopStore(root / 'data', config['settings'])
    lock = vox.InstanceLock(store.directory / 'worker.lock')
    vox.Netdisk = DesktopNetdisk
    vox.Worker = DesktopWorker
    server = ThreadingHTTPServer(('127.0.0.1', 0), DesktopHandler)
    server.daemon_threads = True
    server.desktop_token = config['token']
    server.store = store
    server.worker = DesktopWorker(store)
    server.cleanup = TaskWorkspaces(store, root)
    server.authorization = vox.Authorization(root, server.server_port, vox.save_authorization,
        lambda: store.settings()['proxy'], account_saver=lambda account_id, content:
        vox.save_authorization('token', content, store.account_token_path(account_id)))
    server.worker.authorization = server.authorization
    worker_thread = threading.Thread(target=server.worker.loop, daemon=True)
    worker_thread.start()
    cleanup_thread = threading.Thread(target=server.cleanup.loop, daemon=True)
    cleanup_thread.start()

    def stop():
        server.worker.stop.set()
        server.cleanup.stop.set()
        server.authorization.cancel()
        threading.Thread(target=server.shutdown, daemon=True).start()

    def read_parent():
        try:
            for line in sys.stdin:
                message = json.loads(line)
                if message.get('kind') == 'stop':
                    break
                with _pending_lock:
                    item = _pending.get(message.get('id'))
                if item:
                    item[1].update(message)
                    item[0].set()
        finally:
            with _pending_lock:
                for event, holder in _pending.values():
                    holder['error'] = 'DramaBridge 已关闭桌面桥接'
                    event.set()
            stop()

    reader = threading.Thread(target=read_parent, daemon=True)
    reader.start()
    signal.signal(signal.SIGTERM, lambda *_: stop())
    signal.signal(signal.SIGINT, lambda *_: stop())
    emit({'kind': 'ready', 'port': server.server_port})
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.worker.shutdown()
        server.cleanup.stop.set()
        cleanup_thread.join(timeout=5)
        worker_thread.join(timeout=20)
        server.server_close()
        lock.file.close()


if __name__ == '__main__':
    try:
        if '--check' in sys.argv:
            emit({'kind': 'environment', 'value': environment_status()})
        else:
            serve(json.loads(sys.stdin.readline()))
    except Exception as exc:
        emit({'kind': 'error', 'error': str(exc)})
        raise SystemExit(1)
