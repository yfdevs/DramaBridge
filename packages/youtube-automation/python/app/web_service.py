"""DramaVox local web service with bounded download/processing overlap."""
import argparse
import json
import os
import re
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from contextlib import nullcontext
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, parse_qs
from urllib.request import ProxyHandler, Request, build_opener
from windows_job import ProcessJob, hidden_process_options
from pipeline_events import parse_line, UPLOAD_STAGES
from oauth_service import Authorization, save_token, test_authorization
from task_timings import transition, update_timings
from task_workspaces import TaskWorkspaces
from merge_plan import MERGE_PIPELINE_VERSION
from project_paths import ROOT, credential_path, prepare_layout

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ACTIVE = {"downloading", "processing", "uploading", "waiting"}
DEFAULTS = {"netdiskUrl": "http://127.0.0.1:18439/api", "proxy": "http://127.0.0.1:7897", "paused": False}


def save_authorization(kind, content, target=None):
    if kind != "token":
        raise ValueError("授权信息格式无效")
    save_token(target if target is not None else credential_path(ROOT, "token.json"), content)


def now():
    return datetime.now(timezone.utc).isoformat()


def validate_url(value, local=False):
    url = urlsplit(value)
    if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or url.fragment:
        raise ValueError("请输入有效的 HTTP(S) 地址，不支持用户名、密码或片段")
    if local and (url.hostname not in {"127.0.0.1", "localhost", "::1"} or url.query):
        raise ValueError("百度接口必须是本机地址，且不能包含查询参数")
    return value.rstrip("/")


def validate_task(body):
    name = str(body.get("resourceName", "")).strip()
    if not name or len(name) > 100 or re.search(r'[<>:"/\\|?*\x00-\x1f]', name) or name.endswith((".", " ")):
        raise ValueError("剧名需为 1–100 个字符，不能包含 Windows 文件名非法字符")
    if re.fullmatch(r"(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", name):
        raise ValueError("剧名不能是 Windows 保留文件名")
    share = str(body.get("shareText", "")).strip()
    if len(share) > 4096 or not re.search(r"https?://pan\.baidu\.com/s/[^\s]+", share):
        raise ValueError("请粘贴百度网盘 /s/ 分享链接，可包含提取码")
    count = body.get("episodeCount")
    if count in (None, ""):
        count = None
    elif isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= 10000:
        raise ValueError("集数必须为 1–10000 的整数，留空则自动识别")
    timeout = body.get("timeoutSeconds", 86400)
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= 86400:
        raise ValueError("下载时限必须为 1–86400 秒")
    privacy = body.get("privacy", "private")
    if privacy not in {"private", "unlisted", "public"}:
        raise ValueError("无效的视频可见性")
    mode = body.get("mode", "merge")
    if mode not in {"merge", "episodes", "mute"}:
        raise ValueError("无效的处理模式")
    tags = body.get("tags", [])
    if not isinstance(tags, list) or any(not isinstance(x, str) for x in tags) or len(",".join(tags)) > 500:
        raise ValueError("标签总长度不得超过 500 个字符")
    title = str(body.get("title", "")).strip() or name
    description = str(body.get("description", ""))
    if len(title) > 100 or len(description) > 5000:
        raise ValueError("标题最多 100 字，描述最多 5000 字")
    for key in ("fast", "noUpload", "compress"):
        if key in body and not isinstance(body[key], bool):
            raise ValueError("无效的开关参数")
    if body.get("compress") and mode != "mute":
        raise ValueError("仅静音模式支持压缩")
    account_id = 'default' if body.get('noUpload') else body.get("accountId", "default")
    if not isinstance(account_id, str) or not re.fullmatch(r"default|[a-f0-9]{32}", account_id):
        raise ValueError("请选择有效的上传账号")
    return dict(resourceName=name, shareText=share, episodeCount=count, timeoutSeconds=timeout,
                title=title, description=description, tags=tags, privacy=privacy,
                mode=mode, compress=body.get("compress", False), fast=body.get("fast", False), noUpload=body.get("noUpload", False), accountId=account_id)


class Store:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / "queue.sqlite3"
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS tasks (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
                    status TEXT NOT NULL, payload TEXT NOT NULL, created TEXT NOT NULL,
                    updated TEXT NOT NULL, remote_id TEXT, remote_base TEXT, local_path TEXT,
                    progress TEXT, error TEXT, logs TEXT NOT NULL DEFAULT '', result TEXT);
                CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS worker_clock (id INTEGER PRIMARY KEY, heartbeat TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS youtube_accounts (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT NOT NULL);
            """)
            account_columns = {row[1] for row in db.execute("PRAGMA table_info(youtube_accounts)")}
            if 'deleted' not in account_columns:
                db.execute("ALTER TABLE youtube_accounts ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0")
            db.execute("INSERT OR IGNORE INTO youtube_accounts(id,name,created) VALUES (?, ?, ?)",
                       ("default", "默认账号（原授权）", now()))
            columns = {row[1] for row in db.execute("PRAGMA table_info(tasks)")}
            if "remote_paused" not in columns:
                db.execute("ALTER TABLE tasks ADD COLUMN remote_paused INTEGER NOT NULL DEFAULT 0")
            if "download_generation" not in columns:
                db.execute("ALTER TABLE tasks ADD COLUMN download_generation TEXT")
            if "timings" not in columns:
                db.execute("ALTER TABLE tasks ADD COLUMN timings TEXT NOT NULL DEFAULT '{}'")

    def connect(self):
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        return db

    def settings(self):
        with self.connect() as db:
            row = db.execute("SELECT value FROM settings WHERE id=1").fetchone()
        return {**DEFAULTS, **(json.loads(row[0]) if row else {})}

    def save_settings(self, values):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT value FROM settings WHERE id=1").fetchone()
            current = {**DEFAULTS, **(json.loads(row[0]) if row else {}), **values}
            db.execute("INSERT OR REPLACE INTO settings VALUES(1, ?)", (json.dumps(current),))
        return current

    def account(self, account_id):
        if not isinstance(account_id, str):
            raise ValueError("请选择有效的上传账号")
        with self.connect() as db:
            row = db.execute("SELECT id,name,created FROM youtube_accounts WHERE id=? AND deleted=0", (account_id,)).fetchone()
        if not row:
            raise ValueError("上传账号不存在，请重新选择")
        return dict(row)

    def account_token_path(self, account_id):
        account = self.account(account_id)
        return (credential_path(self.directory.parent, "token.json") if account_id == "default" else
                self.directory / "youtube-accounts" / account['id'] / "token.json")

    def account_log_path(self, account_id):
        if account_id == 'default':
            self.account(account_id)
            return credential_path(self.directory.parent, 'uploaded.json')
        return self.account_token_path(account_id).with_name("uploaded.json")

    def accounts(self):
        with self.connect() as db:
            rows = db.execute("SELECT id,name,created FROM youtube_accounts WHERE deleted=0 ORDER BY created,id").fetchall()
        return [{**dict(row), "authorized": (credential_path(self.directory.parent, 'token.json') if row['id'] == 'default' else
                self.directory / 'youtube-accounts' / row['id'] / 'token.json').is_file()} for row in rows]

    def save_account(self, name, account_id=None):
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60 or any(ord(c) < 32 for c in name):
            raise ValueError("账号名称需为 1–60 个字符，不能包含控制字符")
        if account_id is not None:
            self.account(account_id)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM youtube_accounts WHERE name=? AND id!=? AND deleted=0",
                          (name.strip(), account_id or '')).fetchone():
                raise ValueError("账号名称已存在，请换一个名称")
            if account_id is None:
                account_id = uuid.uuid4().hex
                db.execute("INSERT INTO youtube_accounts(id,name,created) VALUES (?, ?, ?)", (account_id, name.strip(), now()))
            else:
                db.execute("UPDATE youtube_accounts SET name=? WHERE id=?", (name.strip(), account_id))
        return {**self.account(account_id), "authorized": self.account_token_path(account_id).is_file()}

    def delete_account(self, account_id):
        token_path = self.account_token_path(account_id)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute("SELECT 1 FROM youtube_accounts WHERE id=? AND deleted=0", (account_id,)).fetchone():
                raise ValueError("账号已删除，请刷新列表")
            for task in db.execute("SELECT payload FROM tasks WHERE status NOT IN ('completed','deleted')"):
                payload = json.loads(task['payload'])
                if not payload.get('noUpload') and payload.get('accountId', 'default') == account_id:
                    raise ValueError("仍有未完成任务使用此账号，请先完成或删除这些任务")
            token_path.unlink(missing_ok=True)
            db.execute("UPDATE youtube_accounts SET deleted=1 WHERE id=?", (account_id,))
        return {'deleted': True, 'accountId': account_id}

    def create(self, payload):
        payload = validate_task(payload)
        task_id = str(uuid.uuid4())
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if payload['noUpload']:
                payload['accountName'] = ''
            else:
                account = self.account(payload["accountId"])
                if account['id'] != 'default' and not self.account_token_path(account['id']).is_file():
                    raise ValueError("所选上传账号尚未授权，请先在服务设置中完成授权")
                payload['accountName'] = account['name']
            created = now()
            db.execute("INSERT INTO tasks(id,status,payload,created,updated,timings) VALUES(?,?,?,?,?,?)",
                       (task_id, "queued", json.dumps(payload), created, created,
                        json.dumps(transition({}, "queued", created))))
        return self.get(task_id)

    @staticmethod
    def decode(row, detail=True):
        if not row:
            return None
        item = dict(row)
        for key in ("payload", "progress", "result", "timings"):
            item[key] = json.loads(item[key]) if item[key] else None
        if not detail:
            item.pop("logs", None)
            item["payload"].pop("shareText", None)
        return item

    def get(self, task_id):
        with self.connect() as db:
            return self.decode(db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())

    def list(self):
        with self.connect() as db:
            rows = db.execute("SELECT * FROM tasks WHERE status != 'deleted' ORDER BY seq DESC LIMIT 500").fetchall()
        return [self.decode(row, False) for row in rows]

    def update(self, task_id, **values):
        values["updated"] = now()
        progress_values = dict(values)
        for key in ("progress", "result"):
            if key in values and values[key] is not None:
                values[key] = json.dumps(values[key], ensure_ascii=False)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT status,timings FROM tasks WHERE id=?", (task_id,)).fetchone()
            if not row or ("status" in values and row['status'] in {'paused', 'deleted', 'cancelled'}):
                return
            values['timings'] = json.dumps(update_timings(json.loads(row['timings']), progress_values, values['updated']))
            guard = " AND status NOT IN ('paused','deleted','cancelled')" if "status" in values else ""
            db.execute("UPDATE tasks SET " + ",".join(f"{k}=?" for k in values) + " WHERE id=?" + guard,
                       (*values.values(), task_id))

    def log(self, task_id, text):
        # Bounded per-task log prevents progress output from growing the DB forever.
        with self.connect() as db:
            db.execute("UPDATE tasks SET logs=substr(logs || ?, -32000), updated=? WHERE id=?",
                       (text[-4000:], now(), task_id))

    def recover(self):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            clock = db.execute("SELECT heartbeat FROM worker_clock WHERE id=1").fetchone()
            for row in db.execute("SELECT id,updated,timings FROM tasks WHERE status IN ('queued','downloading','processing','uploading','waiting')").fetchall():
                last_seen = min(now(), max(row['updated'], clock[0] if clock else row['updated']))
                timings = transition(json.loads(row['timings']), None, last_seen, 'interrupted')
                at = now()
                transition(timings, 'queued', at)
                db.execute("UPDATE tasks SET status='queued',updated=?,timings=? WHERE id=?", (at, json.dumps(timings), row['id']))

    def pulse(self, task_id=None):
        # Last heartbeat bounds an interrupted run; service downtime is never charged.
        with self.connect() as db:
            at = now()
            db.execute("INSERT OR REPLACE INTO worker_clock(id,heartbeat) VALUES(1,?)", (at,))
            if task_id:
                db.execute("UPDATE tasks SET updated=? WHERE id=? AND status IN ('downloading','processing','uploading','waiting')", (at, task_id))

    def finish_timing(self, task_id):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT timings FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row:
                timings = transition(json.loads(row['timings']), None, now(), 'interrupted')
                db.execute("UPDATE tasks SET timings=? WHERE id=?", (json.dumps(timings), task_id))

    def claim(self):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("""SELECT * FROM tasks AS candidate WHERE status='queued'
                AND NOT EXISTS (SELECT 1 FROM tasks AS active
                    WHERE active.status IN ('downloading','waiting','processing','uploading')
                    AND json_extract(active.payload, '$.resourceName') = json_extract(candidate.payload, '$.resourceName'))
                ORDER BY seq LIMIT 1""").fetchone()
            if row:
                at = now()
                timings = transition(json.loads(row['timings']), 'downloading', at)
                db.execute("UPDATE tasks SET status='downloading', updated=?,timings=? WHERE id=?", (at, json.dumps(timings), row["id"]))
        return self.get(row["id"]) if row else None

    def action(self, task_id, action):
        if action == 'retry':
            task = self.get(task_id)
            if task and task['status'] in ('failed', 'cancelled') and time.time() - datetime.fromisoformat(task['updated']).timestamp() > 86400:
                from task_workspaces import TaskWorkspaces
                result = TaskWorkspaces(self, self.directory.parent).clean_task(task_id)
                if result['errors']:
                    raise ValueError('旧任务临时文件未能安全清理，请检查目录后重试')
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT status,timings,updated FROM tasks WHERE id=?", (task_id,)).fetchone()
            if not row or row[0] == "deleted":
                raise KeyError("任务不存在")
            expected = {"retry": {"failed", "cancelled"}, "cancel": {"queued"},
                        "pause": {"queued", *ACTIVE}, "resume": {"paused"},
                        "delete": {"queued", "paused", "completed", "failed", "cancelled", *ACTIVE}}.get(action)
            if expected is None or row[0] not in expected:
                raise ValueError("当前状态不支持此操作，请刷新任务状态后重试")
            if action == 'retry' and time.time() - datetime.fromisoformat(row['updated']).timestamp() > 86400:
                db.execute('UPDATE tasks SET local_path=NULL,remote_id=NULL,remote_base=NULL,remote_paused=0,'
                           'progress=NULL,download_generation=? WHERE id=?', (uuid.uuid4().hex, task_id))
            state = {"retry": "queued", "resume": "queued", "cancel": "cancelled", "pause": "paused", "delete": "deleted"}[action]
            at = now()
            timings = transition(json.loads(row['timings']), 'queued' if state == 'queued' else None, at, 'interrupted')
            db.execute("UPDATE tasks SET status=?, error=NULL, updated=?,timings=? WHERE id=?",
                       (state, at, json.dumps(timings), task_id))
        return self.get(task_id)


class Netdisk:
    def __init__(self, base):
        self.base = base.rstrip("/")
        self.opener = build_opener(ProxyHandler({}))

    def call(self, path, payload=None):
        request = Request(self.base + path, data=json.dumps(payload).encode() if payload is not None else None,
                          headers={"Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=15) as response:
                result = json.load(response)
        except HTTPError as exc:
            try:
                result = json.loads(exc.read())
            except (ValueError, OSError):
                raise RuntimeError(f"百度接口 HTTP {exc.code}") from exc
            error = result.get("error", {})
            raise RuntimeError(f"{error.get('code', exc.code)}: {error.get('message', '百度接口请求失败')}") from exc
        if not result.get("success"):
            raise RuntimeError(result.get("error", {}).get("message", "百度接口返回失败"))
        return result.get("data", {})


class Worker:
    def __init__(self, store, client_factory=Netdisk, poll_seconds=3):
        self.store = store
        self.client_factory = client_factory
        self.poll_seconds = poll_seconds
        self.stop = threading.Event()
        self.process = None
        self.job = None
        self.process_lock = threading.RLock()
        self.current_id = None
        self.current_abort = threading.Event()
        self.children = {}
        self.download_gate = threading.Lock()
        self.pipeline_gate = threading.Lock()

    def busy(self):
        with self.process_lock:
            return self.process is not None or any(child.process is not None for child, _ in self.children.values())

    def active_ids(self):
        with self.process_lock:
            return ([self.current_id] if self.current_id else []) + list(self.children)

    def halted(self, task):
        current = self.store.get(task["id"])
        return (self.stop.is_set() or not current or current["status"] in {"paused", "deleted", "cancelled"}
                or (self.current_id == task["id"] and self.current_abort.is_set()))

    def _terminate_locked(self):
        if self.job:
            self.job.close()
            self.job = None
        process = self.process
        if process and process.poll() is None:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, **hidden_process_options())
            else:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass

    def pause_remote(self, task):
        if not task or not task["remote_id"] or task["local_path"]:
            return
        try:
            self.client_factory(task["remote_base"] or self.store.settings()["netdiskUrl"]).call(
                "/baidu-netdisk/downloads/" + task["remote_id"] + "/pause", {})
            self.store.update(task["id"], remote_paused=1)
        except Exception as exc:
            # Native queued/completed tasks cannot be paused. Local stop remains authoritative.
            if "TASK_NOT_RUNNING" not in str(exc):
                self.store.log(task["id"], f"本地已停止后续处理，网盘暂停请求未成功：{exc}\n")

    def control(self, task_id, action):
        with self.process_lock:
            delegate = self.children.get(task_id)
        if delegate:
            return delegate[0].control(task_id, action)
        with self.process_lock:
            task = self.store.action(task_id, action)
            if action in {"pause", "delete", "cancel"}:
                if self.current_id == task_id:
                    self.current_abort.set()
                    self._terminate_locked()
        if action in {"pause", "delete", "cancel"}:
            self.pause_remote(task)
        return task

    def loop(self):
        self.store.recover()
        next_pulse = 0
        while not self.stop.is_set():
            try:
                if time.monotonic() >= next_pulse:
                    self.store.pulse()
                    next_pulse = time.monotonic() + 5
                authorization = getattr(self, "authorization", None)
                with self.process_lock:
                    self.children = {key: value for key, value in self.children.items() if value[1].is_alive()}
                    available = len(self.children) < 2
                task = None if not available or self.store.settings()["paused"] or (authorization and authorization.pending()) else self.store.claim()
                if task:
                    child = Worker(self.store, self.client_factory, self.poll_seconds)
                    child.authorization = authorization
                    child.stop = self.stop
                    # Honor instance-specific download and pipeline hooks.
                    for name in ('download', 'run_pipeline'):
                        if name in self.__dict__:
                            setattr(child, name, self.__dict__[name])
                    thread = threading.Thread(target=child.execute, args=(task,), daemon=True)
                    child.download_gate = self.download_gate
                    child.pipeline_gate = self.pipeline_gate
                    child.process_lock = self.process_lock
                    with self.process_lock:
                        self.children[task['id']] = (child, thread)
                        thread.start()
                else:
                    self.stop.wait(.2)
            except Exception as exc:
                print(f"Queue error: {exc}", flush=True)
                self.stop.wait(3)

    def download(self, task):
        payload = task["payload"]
        # Save endpoint before submitting: an interrupted POST can be recovered idempotently.
        base = task["remote_base"] or self.store.settings()["netdiskUrl"]
        self.store.update(task["id"], remote_base=base)
        client = self.client_factory(base)
        waiting_logged = False
        evaluate_retries = 0
        deadline = time.monotonic() + payload["timeoutSeconds"] + 300
        while not self.halted(task):
            if time.monotonic() > deadline:
                raise RuntimeError("等待百度接口超过下载时限，请检查客户端后重试；原下载编号已保留")
            try:
                if task.get("remote_paused") and task["remote_id"]:
                    try:
                        client.call("/baidu-netdisk/downloads/" + task["remote_id"] + "/resume", {})
                    except RuntimeError as exc:
                        if "TASK_NOT_RUNNING" not in str(exc):
                            raise
                    self.store.update(task["id"], remote_paused=0)
                    task["remote_paused"] = 0
                if task["remote_id"]:
                    remote = client.call("/baidu-netdisk/downloads/" + task["remote_id"])
                else:
                    request_id = task['id'] + (':' + task['download_generation'] if task.get('download_generation') else '')
                    params = dict(requestId=request_id, shareText=payload["shareText"],
                                  resourceName=payload["resourceName"], downloadEpisodeVideos=True,
                                  downloadAssetMaterials=False, timeoutSeconds=payload["timeoutSeconds"])
                    if payload["episodeCount"]:
                        params["episodeCount"] = payload["episodeCount"]
                    else:
                        params["inferEpisodeCount"] = True
                    remote = client.call("/baidu-netdisk/downloads", params)
                    task["remote_id"] = remote["taskId"]
                    self.store.update(task["id"], remote_id=remote["taskId"])
                with self.process_lock:
                    if self.halted(task):
                        return None
                    waiting_logged = False
                    self.store.update(task["id"], status="downloading", error=None,
                                      progress={"stage": "downloading", **(remote.get("progress") or {})})
                status = remote["status"]
                if status == 'failed':
                    message = (remote.get('error') or {}).get('message', '')
                    episode_problem = any(word in message for word in
                        ('剧集不完整', '集数不匹配', '缺少剧集', '缺集', '未找到剧集', '没有找到剧集', '没有可下载的剧集'))
                    if episode_problem and not any(word in message.lower() for word in
                            ('网络', '超时', '连接', 'timeout', 'network', '登录')):
                        partial_path = (remote.get('result') or {}).get('localPath')
                        if partial_path:
                            self.store.update(task['id'], local_path=str(partial_path))
                        task['_episode_problem'] = True
                        raise RuntimeError(message)
                if status == "completed":
                    path = Path(remote["result"]["localPath"])
                    if not path.exists():
                        raise RuntimeError(f"下载记录已完成，但本地文件不存在：{path}。请在网盘应用确认下载目录")
                    self.store.update(task["id"], local_path=str(path))
                    return path
                if status in {"failed", "timed_out", "interrupted"}:
                    message = (remote.get('error') or {}).get('message', '')
                    if 'Runtime.evaluate' in message and ('超时' in message or 'timeout' in message.lower()):
                        if evaluate_retries >= 3:
                            raise RuntimeError('DramaBridge 网盘脚本 Runtime.evaluate 连续超时，已停止自动恢复；'
                                               '请检查网盘客户端响应和登录状态，并更新 DramaBridge 的脚本超时设置。')
                        evaluate_retries += 1
                        delay = 10 * 2 ** (evaluate_retries - 1)
                        self.store.log(task['id'], f'网盘脚本超时，{delay} 秒后恢复原下载任务（{evaluate_retries}/3）。\n')
                        self.store.update(task['id'], status='waiting', error='等待网盘脚本恢复')
                        if self.stop.wait(delay) or self.halted(task):
                            return None
                        client.call('/baidu-netdisk/downloads/' + task['remote_id'] + '/retry', {})
                        task['_retry_remote'] = False
                        continue
                    # Retry only when explicitly requested via our failed-task retry action.
                    if task.get("_retry_remote") or status == "interrupted":
                        client.call("/baidu-netdisk/downloads/" + task["remote_id"] + "/retry", {})
                        task["_retry_remote"] = False
                        self.store.log(task["id"], "已恢复百度下载任务。\n")
                    else:
                        raise RuntimeError((remote.get("error") or {}).get("message", f"下载失败：{status}"))
            except (URLError, TimeoutError, ConnectionError, OSError) as exc:
                self.store.update(task["id"], status="waiting", error="等待百度网盘接口恢复连接")
                if not waiting_logged:
                    self.store.log(task["id"], f"百度接口暂不可用，将自动重连：{exc}\n")
                    waiting_logged = True
            except RuntimeError as exc:
                if 'Runtime.evaluate' in str(exc) and ('超时' in str(exc) or 'timeout' in str(exc).lower()):
                    if evaluate_retries >= 3:
                        raise RuntimeError('DramaBridge 网盘脚本连续超时，请检查网盘客户端响应和登录状态，并更新 DramaBridge 的脚本超时设置。') from exc
                    evaluate_retries += 1
                    delay = 10 * 2 ** (evaluate_retries - 1)
                    self.store.update(task['id'], status='waiting', error='等待网盘脚本恢复')
                    self.store.log(task['id'], f'百度接口脚本超时，{delay} 秒后查询原下载任务（{evaluate_retries}/3）。\n')
                    if self.stop.wait(delay):
                        return None
                    continue
                if "TASK_STOPPING" not in str(exc) and "SERVICE_STOPPED" not in str(exc):
                    raise
            self.stop.wait(self.poll_seconds)
        return None

    def cleanup_finished_task(self, task):
        try:
            result = TaskWorkspaces(self.store, ROOT).clean_task(task['id'])
            self.store.log(task['id'], f"自动清理释放 {result['removedBytes'] / 1024**2:.1f} MB。\n")
            for error in result['errors']:
                self.store.log(task['id'], f"自动清理异常：{error}\n")
        except Exception as exc:
            self.store.log(task['id'], f"自动清理异常：{exc}\n")

    def execute(self, task):
        heartbeat_stop = threading.Event()
        def heartbeat():
            while not heartbeat_stop.wait(5):
                try:
                    self.store.pulse(task['id'])
                except sqlite3.Error:
                    pass
        heartbeat_thread = threading.Thread(target=heartbeat, daemon=True)
        with self.process_lock:
            self.current_id = task["id"]
            self.current_abort = threading.Event()
        try:
            if self.halted(task):
                return
            if self.store.settings()["paused"]:
                self.store.update(task["id"], status="queued")
                return
            heartbeat_thread.start()
            self.store.log(task["id"], f"\n[{now()}] 开始 / 恢复任务\n")
            # A failed remote task is retried at most once per explicit local attempt.
            task["_retry_remote"] = bool(task["remote_id"])
            local = Path(task["local_path"]) if task["local_path"] else None
            if not local or not local.exists():
                while not self.halted(task):
                    if self.download_gate.acquire(timeout=.2):
                        try:
                            local = self.download(task)
                        finally:
                            self.download_gate.release()
                        break
            if self.halted(task):
                return
            self.store.update(task['id'], status='processing', progress={'stage': 'preparing', 'message': '下载完成，等待处理资源'})
            while not self.halted(task):
                if self.pipeline_gate.acquire(timeout=.2):
                    try:
                        if not self.halted(task):
                            self.run_pipeline(task, local)
                    finally:
                        self.pipeline_gate.release()
                    break
            if not self.halted(task):
                self.store.update(task["id"], status="completed", error=None, progress={"stage": "completed", "percent": 100})
        except Exception as exc:
            if not self.halted(task):
                self.store.log(task["id"], f"任务失败：{exc}\n")
                self.store.update(task["id"], status="failed", error=str(exc))
        finally:
            finished = self.store.get(task['id'])
            if finished and (finished['status'] == 'completed' or
                             finished['status'] == 'failed' and task.get('_episode_problem')):
                self.cleanup_finished_task(finished)
            heartbeat_stop.set()
            if heartbeat_thread.is_alive():
                heartbeat_thread.join(timeout=1)
            saved = self.store.get(task['id'])
            if saved and saved['status'] != 'queued':
                self.store.finish_timing(task['id'])
            saved = self.store.get(task["id"])
            if saved and saved["status"] in {"paused", "deleted"}:
                self.pause_remote(saved)
            with self.process_lock:
                if self.current_id == task["id"]:
                    self.current_id = None

    def run_pipeline(self, task, local):
        payload = task["payload"]
        self.store.update(task["id"], status="processing", progress=None, error=None)
        from task_workspaces import TaskWorkspaces
        workspace = TaskWorkspaces(self.store, ROOT).prepare(task['id'])
        args = [sys.executable, "-u", str(ROOT / "app" / "upload_to_youtube.py"), str(local),
                "--work-dir", str(workspace), "--task-id", task['id'],
                "--title", payload["title"], "--description", payload["description"],
                "--privacy", payload["privacy"]]
        if not payload['noUpload']:
            account_id = payload.get('accountId', 'default')
            args += ['--token-file', str(self.store.account_token_path(account_id)),
                     '--upload-log', str(self.store.account_log_path(account_id)), '--no-browser-auth']
        if local.is_dir():
            args.append("--recursive")
        for enabled, flag in ((payload["mode"] == "merge" and local.is_dir(), "--merge"),
                              (payload["mode"] == "mute", "--mute"),
                              (payload.get("compress", False), "--compress"),
                              (payload["mode"] != "mute" and payload["fast"], "--fast"), (payload["noUpload"], "--no-upload")):
            if enabled:
                args.append(flag)
        proxy = self.store.settings()["proxy"]
        # Pass empty explicitly so clearing the setting really selects direct
        # mode instead of inheriting the service's environment/system proxy.
        args += ["--proxy", proxy]
        if payload["tags"]:
            args += ["--tags", *payload["tags"]]
        env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1",
               "DRAMAVOX_EVENTS": "1", "DRAMAVOX_TASK_DB": str(self.store.path), "DRAMAVOX_TASK_ID": task["id"]}
        flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        flags |= hidden_process_options().get('creationflags', 0)
        while True:
            with self.process_lock:
                guard = getattr(self, 'check_pipeline_space', None)
                if guard:
                    guard()
                if self.halted(task):
                    return
                authorization = getattr(self, "authorization", None)
                if not authorization or not authorization.pending():
                    self.job = ProcessJob()
                    process = subprocess.Popen(args, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                               text=True, encoding="utf-8", errors="replace", creationflags=flags,
                                               start_new_session=os.name != "nt")
                    self.process = process
                    self.job.assign(process)
                    break
            self.stop.wait(0.5)
        progress = None
        try:
          with process:
            # Demucs emits carriage-return progress, so read bounded chunks of lines.
            while True:
                line = process.stdout.readline(2000)
                if not line:
                    break
                if self.halted(task):
                    break
                self.store.log(task["id"], line)
                event = parse_line(line, progress)
                if event:
                    with self.process_lock:
                        if self.halted(task):
                            break
                        progress = event
                        self.store.update(task["id"], status="uploading" if event["stage"] in UPLOAD_STAGES else "processing",
                                          progress=event)
                urls = re.findall(r"https://youtu\.be/[A-Za-z0-9_-]+", line)
                if urls:
                    current = self.store.get(task["id"])["result"] or {"videoUrls": []}
                    current["videoUrls"] = list(dict.fromkeys(current["videoUrls"] + urls))
                    self.store.update(task["id"], result=current)
            code = process.wait()
        finally:
            with self.process_lock:
                if self.process is process:
                    self.process = None
                    if self.job:
                        self.job.close()
                        self.job = None
        if code and not self.halted(task):
            raise RuntimeError(f"分离 / 上传程序退出，代码 {code}。请查看下方执行日志后重试")

    def shutdown(self):
        self.stop.set()
        with self.process_lock:
            for child, _ in self.children.values():
                child.shutdown()
            self.current_abort.set()
            self._terminate_locked()
        for _, thread in list(self.children.values()):
            thread.join(timeout=2)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    @property
    def store(self):
        return self.server.store

    def send_json(self, value, status=200):
        raw = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(raw)

    def trusted_request(self):
        host = self.headers.get("Host", "")
        addresses = {"127.0.0.1", "localhost", self.server.server_address[0]}
        try:
            addresses.update(socket.gethostbyname_ex(socket.gethostname())[2])
        except OSError:
            pass
        addresses.discard("0.0.0.0")
        allowed = {f"{address}:{self.server.server_port}" for address in addresses}
        if host not in allowed:
            return False
        origin = self.headers.get("Origin")
        return not origin or origin == f"http://{host}"

    def do_GET(self):
        if not self.trusted_request():
            self.send_json({"error": "仅允许本服务同源访问"}, 403)
            return
        path = urlsplit(self.path).path
        if path == "/api/oauth/callback":
            try:
                if self.client_address[0] != "127.0.0.1":
                    raise ValueError("请在服务电脑完成 Google 授权")
                values = parse_qs(urlsplit(self.path).query)
                self.server.authorization.finish(values.get("state", [""])[0], values.get("code", [None])[0], values.get("error", [None])[0])
                message, status = "授权信息已更新，可以关闭此页面并返回 DramaBridge。", 200
            except (ValueError, AttributeError):
                message, status = "授权未更新，请返回 DramaBridge YouTube 工作台查看状态并重新授权。", 400
            raw = ("<!doctype html><html lang=zh-CN><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
                   "<title>DramaBridge 授权</title><body style='font:16px system-ui;margin:64px auto;padding:24px;max-width:540px'>"
                   "<h1 style='font-size:24px'>DramaBridge</h1><p>" + message + "</p>请返回 DramaBridge 桌面应用。</body></html>").encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
            self.end_headers()
            self.wfile.write(raw)
        elif path == "/api/oauth/status":
            self.send_json(self.server.authorization.status())
        elif path == "/api/health":
            self.send_json({"app": "DramaVox", "status": "ok", "taskControls": True, "oauthLogin": True,
                            "serviceControl": True, "accountDeletion": True, "stageTimings": True,
                            "mergePipeline": MERGE_PIPELINE_VERSION,
                            "background": os.environ.get('DRAMAVOX_BACKGROUND') == '1',
                            "backgroundSupervisor": os.environ.get('DRAMAVOX_SUPERVISOR_PID')})
        elif path == "/api/storage":
            self.send_json(self.server.cleanup.scan())
        elif path == "/api/tasks":
            self.send_json({"tasks": self.store.list(), "settings": self.store.settings()})
        elif path == "/api/accounts":
            self.send_json({"accounts": self.store.accounts()})
        elif path.startswith("/api/tasks/"):
            task = self.store.get(path.split("/")[-1])
            if task and task["status"] == "deleted":
                task = None
            self.send_json(task or {"error": "任务不存在"}, 200 if task else 404)
        elif path == "/api/status":
            settings = self.store.settings()
            try:
                remote = Netdisk(settings["netdiskUrl"]).call("/baidu-netdisk/status")
                netdisk = {"connected": True, "detail": remote}
            except Exception as exc:
                netdisk = {"connected": False, "error": str(exc)}
            self.send_json({"netdisk": netdisk, "credentials": credential_path(ROOT, "client_secret.json").exists(),
                            "authorized": any(account['authorized'] for account in self.store.accounts()), "paused": settings["paused"]})
        elif path.startswith("/api/"):
            self.send_json({"error": "接口不存在"}, 404)
        else:
            root = (ROOT / "web" / "dist").resolve()
            from urllib.parse import unquote
            target = (root / unquote(path).lstrip("/")).resolve()
            if not target.is_relative_to(root):
                self.send_json({"error": "无效路径"}, 403)
                return
            if not target.is_file():
                target = root / "index.html"
            if not target.exists():
                self.send_json({"error": "页面尚未构建，请重新解压完整分发包"}, 503)
                return
            import mimetypes
            raw = target.read_bytes()
            self.send_response(200)
            mime = "application/javascript" if target.suffix == ".js" else mimetypes.guess_type(target)[0] or "application/octet-stream"
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-cache" if target.name == "index.html" else "public, max-age=86400")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(raw)

    def do_POST(self):
        if not self.trusted_request():
            self.close_connection = True
            self.send_json({"error": "仅允许本服务同源访问"}, 403)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 65536 or self.headers.get_content_type() != "application/json":
                self.close_connection = True
                raise ValueError("请求必须为 JSON，且大小不能超过 64 KiB")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("请求必须为 JSON 对象")
            path = urlsplit(self.path).path
            if path == "/api/storage/cleanup":
                self.send_json(self.server.cleanup.scan(clean=True))
            elif path == "/api/service/stop":
                if self.client_address[0] != "127.0.0.1":
                    self.send_json({"error": "请在服务电脑运行停止脚本"}, 403)
                    return
                controller = getattr(self.server, "worker", None)
                if controller:
                    controller.stop.set()
                    controller.current_abort.set()
                authorization = getattr(self.server, "authorization", None)
                if authorization:
                    authorization.cancel()
                self.send_json({"stopping": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            elif path in {"/api/oauth/start", "/api/oauth/cancel"}:
                controller = getattr(self.server, "worker", None)
                authorization = self.server.authorization
                with controller.process_lock if controller else nullcontext():
                    if path.endswith("cancel"):
                        authorization.cancel()
                        self.send_json(authorization.status())
                        return
                    if controller and controller.busy():
                        self.send_json({"error": "请先暂停正在分离或上传的任务，再更新授权信息"}, 409)
                        return
                    local = self.client_address[0] == "127.0.0.1" and urlsplit("http://" + self.headers.get("Host", "")).hostname in {"127.0.0.1", "localhost"}
                    account_id = body.get('accountId', 'default')
                    self.store.account(account_id)
                    url = authorization.start(manual=not local, account_id=account_id)
                self.send_json({"url": url, "onServer": False, "manual": not local})
            elif path == "/api/oauth/complete":
                self.server.authorization.finish_redirect(body.get("callbackUrl"))
                self.send_json(self.server.authorization.status())
            elif path == "/api/oauth/test":
                if self.server.authorization.pending():
                    self.send_json({"error": "请先完成或取消正在进行的授权，再测试已保存的授权"}, 409)
                    return
                self.send_json(test_authorization(self.store.account_token_path(body.get('accountId', 'default')), self.store.settings()["proxy"]))
            elif path == "/api/accounts":
                self.send_json(self.store.save_account(body.get('name')), 201)
            elif re.fullmatch(r"/api/accounts/(default|[a-f0-9]{32})/delete", path):
                controller = getattr(self.server, 'worker', None)
                authorization = getattr(self.server, 'authorization', None)
                with controller.process_lock if controller else nullcontext():
                    with authorization.lock if authorization else nullcontext():
                        if authorization and authorization.pending():
                            self.send_json({'error': '请先完成或取消正在进行的授权，再删除账号'}, 409)
                            return
                        self.send_json(self.store.delete_account(path.split('/')[-2]))
            elif re.fullmatch(r"/api/accounts/(default|[a-f0-9]{32})", path):
                self.send_json(self.store.save_account(body.get('name'), path.split('/')[-1]))
            elif path == "/api/tasks":
                self.send_json(self.store.create(body), 201)
            elif re.fullmatch(r"/api/tasks/[^/]+/(retry|cancel|pause|resume|delete)", path):
                _, _, _, task_id, action = path.split("/")
                controller = getattr(self.server, "worker", None)
                self.send_json(controller.control(task_id, action) if controller else self.store.action(task_id, action))
            elif path == "/api/settings":
                values = {}
                if "netdiskUrl" in body:
                    values["netdiskUrl"] = validate_url(str(body["netdiskUrl"]), local=True)
                if "proxy" in body:
                    proxy = str(body["proxy"]).strip()
                    values["proxy"] = validate_url(proxy) if proxy else ""
                if "paused" in body:
                    if not isinstance(body["paused"], bool):
                        raise ValueError("无效的暂停状态")
                    values["paused"] = body["paused"]
                saved = self.store.save_settings(values)
                controller = getattr(self.server, "worker", None)
                if controller and "paused" in values:
                    if values["paused"]:
                        paused_ids = list(saved.get('queuePausedTasks', []))
                        for task_id in controller.active_ids():
                            try:
                                controller.control(task_id, 'pause')
                                paused_ids.append(task_id)
                            except (ValueError, KeyError):
                                pass
                        saved = self.store.save_settings({'queuePausedTasks': paused_ids})
                    else:
                        for task_id in saved.get('queuePausedTasks', []) + ([saved['queuePausedTask']] if saved.get('queuePausedTask') else []):
                            try:
                                controller.control(task_id, 'resume')
                            except (ValueError, KeyError):
                                pass
                        saved = self.store.save_settings({'queuePausedTask': None, 'queuePausedTasks': []})
                self.send_json(saved)
            elif path == "/api/netdisk/start":
                self.send_json(Netdisk(self.store.settings()["netdiskUrl"]).call("/baidu-netdisk/start", {}))
            else:
                self.send_json({"error": "接口不存在"}, 404)
        except KeyError as exc:
            self.send_json({"error": str(exc)}, 404)
        except (ValueError, TypeError) as exc:
            self.send_json({"error": str(exc)}, 400)
        except Exception as exc:
            self.send_json({"error": str(exc)}, 502)


class InstanceLock:
    """OS releases this lock after a crash; alternate ports cannot run a second worker."""
    def __init__(self, path):
        self.file = open(path, "a+b")
        if self.file.tell() == 0:
            self.file.write(b"0")
            self.file.flush()
        self.file.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.file.close()
            print("DramaVox Web 已在运行，请打开现有服务。", flush=True)
            raise SystemExit(2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8008)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    store = Store(ROOT / "data")
    lock = InstanceLock(store.directory / "worker.lock")
    prepare_layout(ROOT)
    try:
        server = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as exc:
        print(f"端口 {args.port} 无法使用：{exc}", flush=True)
        raise SystemExit(2)
    server.daemon_threads = True
    server.store = store
    worker = Worker(store)
    server.worker = worker
    server.cleanup = TaskWorkspaces(store, ROOT)
    cleanup_thread = threading.Thread(target=server.cleanup.loop, daemon=True)
    cleanup_thread.start()
    server.authorization = Authorization(ROOT, args.port, save_authorization, lambda: store.settings()["proxy"],
                                         account_saver=lambda account_id, content: save_authorization(
                                             'token', content, store.account_token_path(account_id)))
    worker.authorization = server.authorization
    thread = threading.Thread(target=worker.loop, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{args.port}"
    mode_hint = ('后台运行中；使用 start.bat stop 停止服务。' if os.environ.get('DRAMAVOX_BACKGROUND') == '1'
                 else '保持窗口开启；Ctrl+C 停止服务。')
    print(f"DramaVox Web: {url}\n{mode_hint}", flush=True)
    if not args.no_browser:
        import webbrowser
        webbrowser.open(url)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("正在停止服务，队列将在下次启动时恢复…", flush=True)
    finally:
        server.cleanup.stop.set()
        cleanup_thread.join(timeout=20)
        worker.shutdown()
        thread.join(timeout=20)
        server.server_close()
        lock.file.close()


if __name__ == "__main__":
    main()
