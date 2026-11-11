"""Observable, cancellable media processes with bounded diagnostic output."""
import math
import queue
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from pipeline_events import current_progress, emit, ensure_running, PHASE_NAMES
from windows_job import hidden_process_options


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


def clock(seconds):
    seconds = max(0, int(seconds))
    return f"{seconds // 3600:02}:{seconds // 60 % 60:02}:{seconds % 60:02}"


def progress_fields(values, duration, elapsed, finished=False):
    micros = number(values.get('out_time_us', values.get('out_time_ms')))
    processed = max(0, micros / 1_000_000) if micros is not None else None
    if processed is None and values.get('out_time'):
        try:
            hours, minutes, seconds = values['out_time'].split(':')
            processed = max(0, int(hours) * 3600 + int(minutes) * 60 + float(seconds))
        except (ValueError, TypeError):
            pass
    duration = number(duration)
    speed = number(str(values.get('speed', '')).rstrip('x'))
    percent = min(99.9, 100 * processed / duration) if duration and duration > 0 and processed is not None else None
    if finished:
        percent = 100
    fields = {'percent': round(percent, 1) if percent is not None else None,
              'elapsedSeconds': round(elapsed, 1)}
    if processed is not None:
        fields['processedSeconds'] = round(processed, 2)
    if duration and duration > 0:
        fields['durationSeconds'] = duration
    if speed and speed > 0:
        fields['speedText'] = f'{speed:.2f} × 实时'
        if duration and processed is not None:
            fields['etaText'] = clock(max(0, duration - processed) / speed)
    for source, target in [('frame', 'frame'), ('fps', 'fps'), ('total_size', 'outputBytes')]:
        value = number(values.get(source))
        if value is not None and value >= 0:
            fields[target] = value
    return fields


def run_media_process(command, duration=None, log_path=None, *, stop_check=ensure_running, notify=emit, on_line=None):
    context = current_progress()
    stage = context.pop('stage', None)
    duration = duration or context.pop('durationSeconds', None)
    completed = context.pop('completedItems', 0)
    total = context.pop('totalItems', None)
    started = time.monotonic()
    last_output = started
    last_log = started - 15
    last_advance = started
    previous_time = -1
    values = {}
    lines = queue.SimpleQueue()
    diagnostic = Path(log_path).open('w+b') if log_path else tempfile.TemporaryFile()

    def publish(finished=False):
        nonlocal last_log, last_advance, previous_time, last_output
        now = time.monotonic()
        fields = progress_fields(values, duration, now - started, finished)
        processed = fields.get('processedSeconds', 0)
        if processed > previous_time:
            previous_time = processed
            last_advance = now
        fields['lastAdvanceSeconds'] = round(now - last_advance, 1)
        if total:
            fraction = fields['percent'] / 100 if fields['percent'] is not None else 0
            fields['percent'] = round(100 * (completed + fraction) / total, 1)
            fields.update(completedItems=completed + (1 if finished else 0), totalItems=total)
            if fields.get('etaText'):
                fields['etaScope'] = 'item'
        if stage:
            notify(stage, **{**context, **fields})
            if finished or now - last_log >= 15:
                parts = [f"{fields['percent']:.1f}%" if fields['percent'] is not None else '正在处理']
                if fields.get('durationSeconds'):
                    parts.append(f"视频时间 {clock(processed)} / {clock(fields['durationSeconds'])}")
                if fields.get('speedText'):
                    parts.append(fields['speedText'])
                if fields.get('etaText'):
                    parts.append(f"预计{'本集' if fields.get('etaScope') == 'item' else '本阶段'}剩余 {fields['etaText']}")
                parts.append(f"已耗时 {clock(now - started)}")
                if fields['lastAdvanceSeconds'] >= 30:
                    parts.append(f"{int(fields['lastAdvanceSeconds'])} 秒未推进，进程仍在运行")
                print(f"[{PHASE_NAMES.get(stage, stage)}] " + '，'.join(parts), flush=True)
                last_log = now
        last_output = now

    stop_check()
    try:
        with subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=diagnostic, text=True, encoding='utf-8', errors='replace',
                              **hidden_process_options()) as process:
            def read():
                try:
                    while True:
                        line = process.stdout.readline(4096)
                        if not line:
                            break
                        lines.put(line)
                finally:
                    lines.put(None)
            reader = threading.Thread(target=read, daemon=True)
            reader.start()
            try:
                publish()
                ended = False
                next_stop_check = 0
                while True:
                    if time.monotonic() >= next_stop_check:
                        stop_check()
                        next_stop_check = time.monotonic() + 1
                    if not ended:
                        try:
                            line = lines.get(timeout=1)
                            if line is None:
                                ended = True
                            elif on_line is not None:
                                update = on_line(line)
                                if update:
                                    values.update(update)
                                if time.monotonic() - last_output >= 1:
                                    publish()
                            elif '=' in line:
                                key, value = line.strip().split('=', 1)
                                values[key] = value
                                if key == 'progress':
                                    publish()
                        except queue.Empty:
                            pass
                    elif process.poll() is None:
                        try:
                            process.wait(timeout=1)
                        except subprocess.TimeoutExpired:
                            pass
                    if ended and process.poll() is not None:
                        break
                    if time.monotonic() - last_output >= 2:
                        publish()
                code = process.wait()
                if code == 0:
                    publish(finished=True)
            except BaseException:
                if process.poll() is None:
                    process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                raise
            finally:
                reader.join(timeout=2)
        diagnostic.flush()
        length = diagnostic.seek(0, 2)
        diagnostic.seek(max(0, length - 8000))
        return subprocess.CompletedProcess(command, code, stdout=b'', stderr=diagnostic.read())
    finally:
        diagnostic.close()


def input_duration(args):
    """Unknown duration stays unknown; never invent a time-based percentage."""
    try:
        if '-t' in args:
            return number(args[args.index('-t') + 1])
        source = args[args.index('-i') + 1]
        if not Path(source).is_file() or Path(source).suffix == '.txt':
            return None
        result = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                                 '-of', 'default=noprint_wrappers=1:nokey=1', str(source)],
                                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=15,
                                **hidden_process_options())
        return number(result.stdout.strip()) if result.returncode == 0 else None
    except (ValueError, IndexError, OSError, subprocess.SubprocessError):
        return None


def run_ffmpeg(args, duration=None, log_path=None):
    return run_media_process(['ffmpeg', '-nostdin', '-hide_banner', '-nostats', '-loglevel', 'warning',
                              '-stats_period', '1', '-progress', 'pipe:1', '-y', *args],
                             duration=duration or current_progress().get('durationSeconds') or input_duration(args), log_path=log_path)
