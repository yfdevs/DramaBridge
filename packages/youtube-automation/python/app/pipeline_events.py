"""Structured CLI progress and durable stop checks shared by the web worker."""
import json
import os
import re
import sqlite3
import time
from contextlib import contextmanager

PREFIX = "DRAMAVOX_EVENT "
UPLOAD_STAGES = {"authorizing", "uploading", "thumbnail"}
STAGES = {"muting", "compressing", "probing", "normalizing", "merging", "extracting", "loading_model", "separating", "saving_audio", "remuxing", *UPLOAD_STAGES}
PHASE_NAMES = {"queued": "排队等待", "downloading": "下载及重连", "preparing": "准备处理",
               "probing": "分析素材", "normalizing": "修复片段", "merging": "拼接原片",
               "extracting": "提取音轨", "loading_model": "加载分离模型", "separating": "人声分离",
               "muting": "移除音轨", "compressing": "压缩视频", "saving_audio": "保存人声", "remuxing": "重混视频", "authorizing": "准备授权", "uploading": "上传视频", "thumbnail": "设置封面"}


class PipelineStopped(SystemExit):
    pass


def ensure_running():
    database = os.environ.get("DRAMAVOX_TASK_DB")
    task_id = os.environ.get("DRAMAVOX_TASK_ID")
    if not database or not task_id:
        return
    # Fail closed: loss of control state must never permit another upload request.
    try:
        with sqlite3.connect(database, timeout=5) as db:
            row = db.execute("SELECT status FROM tasks WHERE id=?", (task_id,)).fetchone()
    except sqlite3.Error as exc:
        raise PipelineStopped(f"无法确认任务状态，已停止上传：{exc}") from exc
    if not row or row[0] in {"paused", "deleted", "cancelled"}:
        raise PipelineStopped("任务已暂停或删除，停止后续处理和上传。")


def emit(stage, percent=None, **details):
    ensure_running()
    if os.environ.get("DRAMAVOX_EVENTS") == "1":
        print(PREFIX + json.dumps({"stage": stage, "percent": percent, **details}, ensure_ascii=False), flush=True)


@contextmanager
def timed_stage(stage, **details):
    """Emit exact completed durations; still report failure when a stop check raises."""
    emit(stage, timing="start", **details)
    started = time.monotonic()
    outcome = "completed"
    try:
        yield
    except BaseException:
        outcome = "interrupted"
        raise
    finally:
        elapsed = round(time.monotonic() - started, 3)
        print(f"[耗时] {PHASE_NAMES.get(stage, stage)}：{elapsed:.2f} 秒（{outcome}）", flush=True)
        # Do not call ensure_running here: it would mask the original exception on pause.
        if os.environ.get("DRAMAVOX_EVENTS") == "1":
            print(PREFIX + json.dumps({"stage": stage, "timing": "finish", "elapsedSeconds": elapsed,
                                      "outcome": outcome}, ensure_ascii=False), flush=True)


def parse_line(line, previous=None):
    """Read structured events; support old CLI logs and Demucs' native progress bar."""
    if PREFIX in line:
        try:
            event = json.loads(line.split(PREFIX, 1)[1])
        except (ValueError, TypeError):
            return None
        if event.get("stage") not in STAGES:
            return None
        percent = event.get("percent")
        if percent is not None:
            if not isinstance(percent, (int, float)) or not 0 <= percent <= 100:
                return None
        return event
    if re.search(r"上传进度\s*[:：]\s*(\d+(?:\.\d+)?)\s*%", line):
        percent = float(re.search(r"[:：]\s*(\d+(?:\.\d+)?)", line)[1])
        return {"stage": "uploading", "percent": min(100, max(0, percent))}
    for text, stage in (("上传中", "uploading"), ("重混", "remuxing"),
                        ("分离全集人声", "separating"), ("demucs 人声分离", "separating"),
                        ("提取", "extracting"), ("先合并", "merging")):
        if text in line:
            return {"stage": stage, "percent": None}
    match = re.search(r"(?:^|\s)(\d{1,3}(?:\.\d+)?)%\|", line)
    if match and (previous or {}).get("stage") not in UPLOAD_STAGES:
        progress = {"stage": "separating", "percent": min(100, float(match[1]))}
        eta = re.search(r"\[[^\]]*<([^,\]]+)", line)
        speed = re.search(r"([\d.]+)seconds/s", line)
        if eta:
            progress["etaText"] = eta[1].strip()
        if speed:
            progress["speedText"] = f"{speed[1]} × 实时"
        return progress
    return None
