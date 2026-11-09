"""Bounded per-stage totals; active runs survive polling and logs being truncated."""
import math
from datetime import datetime


def transition(timings, stage, at, outcome="completed", exact_seconds=None):
    stages = timings.setdefault("stages", {})
    active = timings.get("active")
    if active and stage == active["stage"]:
        return timings
    if active:
        elapsed = max(0, (datetime.fromisoformat(at) - datetime.fromisoformat(active["startedAt"])).total_seconds())
        if isinstance(exact_seconds, (int, float)) and math.isfinite(exact_seconds) and exact_seconds >= 0:
            elapsed = exact_seconds
        total = stages.setdefault(active["stage"], {"elapsedSeconds": 0, "runs": 0})
        total["elapsedSeconds"] = round(total["elapsedSeconds"] + elapsed, 3)
        total["runs"] += 1
        total["lastOutcome"] = outcome
    timings["active"] = {"stage": stage, "startedAt": at} if stage else None
    return timings


def update_timings(timings, values, at):
    progress = values.get("progress") or {}
    active = timings.get("active")
    if progress.get("timing") == "finish":
        if active and active["stage"] == progress.get("stage"):
            transition(timings, None, at, progress.get("outcome", "completed"), progress.get("elapsedSeconds"))
        return timings
    stage = progress.get("stage")
    status = values.get("status")
    if status in {"completed", "failed", "paused", "deleted", "cancelled"}:
        stage = None
    elif not stage:
        if status in {"queued", "downloading", "waiting"}:
            stage = "queued" if status == "queued" else "downloading"
        elif status == "processing" and (not active or active["stage"] in {"queued", "downloading"}):
            stage = "preparing"
        else:
            return timings
    return transition(timings, stage, at, "completed" if status == "completed" or stage else "interrupted")
