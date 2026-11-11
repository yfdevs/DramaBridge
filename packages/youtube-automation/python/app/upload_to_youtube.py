"""视频人声分离并自动上传到 YouTube 频道"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from tempfile import TemporaryDirectory
from pathlib import Path
from fractions import Fraction
from urllib.parse import quote
from project_paths import ROOT, credential_path
from windows_job import hidden_process_options
from pipeline_events import emit, ensure_running, PipelineStopped, timed_stage, progress_context
from ffmpeg_progress import run_ffmpeg, run_media_process, input_duration
from merge_plan import build_merge_plan, video_differences, MERGE_PIPELINE_VERSION

if sys.stdout and hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def compute_input_hash(path: Path) -> str:
    """对输入视频生成稳定短哈希（基于绝对路径），用于防重复上传"""
    return hashlib.sha256(str(path.resolve()).encode("utf-8")).hexdigest()[:16]


def cache_paths(video: Path, work_dir: Path) -> tuple[Path, Path, Path, Path]:
    """分离缓存路径：以输入路径哈希为键，防止不同目录同名视频串音。

    返回 (wav, 分离输出目录, vocals, 缩略图)。"""
    key = compute_input_hash(video)
    stem = video.stem
    wav = work_dir / "audio" / key / f"{stem}.wav"
    separate_out = work_dir / "separated" / key
    vocals = separate_out / "htdemucs" / stem / "vocals.wav"
    thumb = work_dir / "thumbnail" / key / f"{stem}.jpg"
    return wav, separate_out, vocals, thumb


def load_uploaded_log(log_path: Path, strict=False) -> dict:
    """读取已上传记录；文件不存在或损坏时返回空字典"""
    if not log_path.exists():
        return {}
    try:
        data = json.loads(log_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError, OSError) as exc:
        if strict:
            raise SystemExit(f'无法读取上传记录 {log_path}，已停止上传以避免重复；请恢复记录后重试') from exc
        return {}
    if strict and not isinstance(data, dict):
        raise SystemExit(f'上传记录 {log_path} 格式无效，已停止上传以避免重复')
    return data if isinstance(data, dict) else {}


def is_uploaded(log_path: Path, key: str) -> bool:
    return key in load_uploaded_log(log_path, strict=True)


def mark_uploaded(log_path: Path, key: str, video_id: str) -> None:
    log = load_uploaded_log(log_path, strict=True)
    log[key] = video_id
    _atomic_json(log_path, log)


def _atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


class _UploadCheckpointTransport:
    """Persist the session before the SDK can send the first media chunk."""
    def __init__(self, http, path, state):
        self.http, self.path, self.state = http, path, state

    def request(self, uri, method='GET', *args, **kwargs):
        ensure_running()
        response, content = self.http.request(uri, method, *args, **kwargs)
        if response.status in (200, 201, 308):
            if 'location' in response:
                self.state['uri'] = response['location']
                _atomic_json(self.path, self.state)
            elif response.status in (200, 201) and method == 'PUT' and uri == self.state.get('uri'):
                result = json.loads(content)
                if result.get('id'):
                    self.state['video_id'] = result['id']
                    _atomic_json(self.path, self.state)
        return response, content


SUPPORTED_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}
def separation_signature(fast=False):
    return f"vocals-v2:htdemucs:shifts=1:overlap={0.1 if fast else 0.25}"


def default_title(path: Path) -> str:
    return path.stem


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="视频人声分离并自动上传到 YouTube 频道")
    parser.add_argument("input", type=Path, help="输入视频文件或短剧目录")
    parser.add_argument("--title", help="上传标题（默认取文件名）")
    parser.add_argument("--description", default="", help="视频描述（默认空）")
    parser.add_argument("--tags", nargs="*", default=[], help="标签，空格分隔（默认空）")
    parser.add_argument("--privacy", choices=["public", "unlisted", "private"], default="private",
                        help="隐私设置（默认 private）")
    parser.add_argument("--fast", action="store_true", help="快速分离（减少窗口重叠，速度优先，质量可能略降）")
    parser.add_argument("--force", action="store_true", help="强制重新分离和重混（忽略缓存）")
    parser.add_argument("--force-upload", action="store_true", help="已上传过的视频也强制再传一次")
    parser.add_argument("--client-secret", type=Path, help="OAuth 客户端凭据 JSON 路径")
    parser.add_argument("--token-file", type=Path, help="此账号的授权文件路径")
    parser.add_argument("--upload-log", type=Path, help="此账号的已上传记录路径")
    parser.add_argument("--no-browser-auth", action="store_true", help="授权无效时提示在网页更新，不打开服务器浏览器")
    parser.add_argument("--proxy", help="HTTP(S) 代理地址（如 http://127.0.0.1:7890），国内网络访问 Google 必需")
    parser.add_argument("--no-upload", action="store_true", help="只分离重混，不上传")
    parser.add_argument("--batch", action="store_true", help="批量处理目录（输入是目录时自动启用）")
    parser.add_argument("--merge", action="store_true", help="批量处理后按集数顺序合并为一个全集视频")
    parser.add_argument("--recursive", action="store_true", help="同时扫描输入目录中的子目录视频")
    parser.add_argument("--work-dir", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--task-id", help=argparse.SUPPRESS)
    parser.add_argument("--mute", action="store_true", help="合并并移除音轨")
    parser.add_argument("--compress", action="store_true", help="静音版使用高画质压缩")
    args = parser.parse_args(argv)
    if args.compress and not args.mute:
        parser.error("--compress 需要 --mute")
    return args


def _run_ffmpeg(args: list[str]) -> None:
    try:
        result = run_ffmpeg(args)
        if result.returncode:
            raise subprocess.CalledProcessError(result.returncode, result.args, stderr=result.stderr)
    except FileNotFoundError:
        raise SystemExit("未找到 ffmpeg，请确认它已加入 PATH")
    except subprocess.CalledProcessError as e:
        raise SystemExit(f"ffmpeg 执行失败：{e.stderr.decode(errors='replace')[-500:]}")


def extract_audio(input_video: Path, out_wav: Path, duration: float | None = None) -> None:
    """提取音轨为 44.1kHz/16bit 立体声 wav"""
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    # Copied AAC packets can decode to more samples than their timeline spans
    # (encoder padding at episode boundaries). Match PCM to timestamps instead
    # of accumulating those extra samples across the whole drama.
    args = ["-i", str(input_video), "-vn", "-map", "0:a:0",
            "-af", "aresample=async=1:min_hard_comp=0.001:first_pts=0",
            "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le"]
    if duration is not None:
        args += ["-t", str(duration)]
    partial = out_wav.with_name(out_wav.stem + ".partial.wav")
    args += [str(partial)]
    _run_ffmpeg(args)
    partial.replace(out_wav)


def remux_video(input_video: Path, vocals_wav: Path, out_video: Path) -> None:
    """原视频画面（无损复制）+ 人声轨（AAC 192k）重混输出"""
    partial = out_video.with_name(out_video.stem + ".partial.mp4")
    _run_ffmpeg(["-i", str(input_video), "-i", str(vocals_wav),
                 "-map", "0:v:0", "-map", "1:a:0",
                 "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", str(partial)])
    if not _verify_video_decode(partial):
        raise SystemExit(f'最终重混视频解码校验失败，已停止，未上传。保留文件：{partial}')
    partial.replace(out_video)


def natural_sort_key(path: Path) -> list:
    """按文件名中的数字自然排序：第2集排在第10集之前"""
    return [int(part) if part.isdigit() else part.casefold()
            for part in re.split(r"(\d+)", path.name)]


def discover_videos(directory: Path, recursive: bool = False) -> list[Path]:
    """扫描源视频，可包含下载目录的子目录；排除本工具生成的结果"""
    candidates = directory.rglob("*") if recursive else directory.iterdir()
    videos = [
        path for path in candidates
        if path.is_file()
        and path.suffix.lower() in SUPPORTED_EXTENSIONS
        and not path.stem.endswith(("_人声版", "_全集_人声版", "_静音版", ".partial"))
    ]
    # A relative-path tie breaker keeps same-named episodes deterministic across restarts.
    return sorted(videos, key=lambda path: (natural_sort_key(path), path.relative_to(directory).as_posix()))


def _concat_list_line(path: Path) -> str:
    escaped = path.resolve().as_posix().replace("'", "'\\''")
    return f"file '{escaped}'\n"


def _write_concat_list(paths: list[Path], list_path: Path, durations=None) -> None:
    list_path.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    for index, path in enumerate(paths):
        lines.append(_concat_list_line(path))
        if durations is not None:
            lines.append(f'duration {durations[index]:.12f}\n')
    list_path.write_text(''.join(lines), encoding="utf-8")


def _run_concat_copy(paths: list[Path], output: Path, list_path: Path, durations=None) -> bool:
    """Copy prepared video/audio packets; timeline alignment happens on PCM extraction.

    This is an intermediate file for local processing. Moving its MP4 index to
    the front would add a second full-file read/write without helping separation.
    """
    _write_concat_list(paths, list_path, durations)
    log_path = list_path.with_suffix('.ffmpeg.log')
    result = run_ffmpeg(
        ["-f", "concat", "-safe", "0", "-auto_convert", "1", "-i", str(list_path),
         "-map", "0:v:0", "-map", "0:a:0",
         "-c:v", "copy", "-c:a", "copy", str(output)],
        duration=sum(durations) if durations else None, log_path=log_path,
    )
    if result.returncode:
        print("   拼接失败详情：" + result.stderr.decode(errors='replace')[-1500:])
    return result.returncode == 0


def _probe_stream_signature(path: Path):
    """返回影响无损拼接兼容性的音视频流参数；无 ffprobe 时返回 None"""
    if not shutil.which("ffprobe"):
        return None
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_data_hash", "sha256", "-show_entries",
         "stream=codec_type,codec_name,width,height,pix_fmt,profile,level,extradata_hash,nb_frames,r_frame_rate,avg_frame_rate,time_base,sample_aspect_ratio,sample_rate,channels,channel_layout,start_time,duration:format=duration",
         "-of", "json", str(path)],
        check=True, capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL, **hidden_process_options(),
    )
    data = json.loads(result.stdout)
    # These are the same first video/audio streams selected by the concat command.
    selected = []
    for kind in ("video", "audio"):
        stream = next((s for s in data.get("streams", []) if s.get("codec_type") == kind), None)
        if stream is not None:
            selected.append(stream)
    if selected:
        selected[0] = {**selected[0], "container_duration": data.get("format", {}).get("duration")}
    return selected


def _rate(value):
    try:
        rate = float(Fraction(str(value)))
        return rate if rate > 0 else None
    except (ValueError, ZeroDivisionError):
        return None


def _video_signature(streams):
    return next((s for s in streams or [] if s.get("codec_type") == "video"), {})


def _video_matches(a, b, include_time_base=True):
    if not a or not b or video_differences(a, b):
        return False
    if a.get('codec_name') == 'hevc' and (
            not a.get('extradata_hash') or a.get('extradata_hash') != b.get('extradata_hash')):
        return False
    return not include_time_base or _rate(a.get('time_base')) == _rate(b.get('time_base'))


def _audio_signature(streams):
    audio = next((s for s in streams or [] if s.get("codec_type") == "audio"), {})
    return {key: audio.get(key) for key in ("codec_name", "profile", "sample_rate", "channels", "channel_layout", "time_base")}


def _streams_are_concat_compatible(videos: list[Path], signatures=None) -> bool:
    signatures = signatures if signatures is not None else [_probe_stream_signature(video) for video in videos]
    if any(signature is None for signature in signatures):
        return True
    return all(_video_matches(_video_signature(signature), _video_signature(signatures[0]))
               and _audio_signature(signature) == _audio_signature(signatures[0])
               for signature in signatures[1:])


def _verify_video_decode(output):
    """Decode every frame, retaining the complete error log and live progress."""
    log_path = output.with_name(output.name + '.decode.log')
    try:
        with timed_stage('validating', message='完整解码校验，检查全部拼接点'):
            result = run_media_process(
                ['ffmpeg', '-nostdin', '-hide_banner', '-v', 'error', '-nostats',
                 '-stats_period', '1', '-progress', 'pipe:1', '-xerror',
                 '-err_detect', 'explode', '-i', str(output), '-map', '0:v:0',
                 '-an', '-f', 'null', '-'],
                duration=input_duration(['-i', str(output)]), log_path=log_path)
            if result.returncode or log_path.stat().st_size:
                raise subprocess.CalledProcessError(result.returncode or 1, result.args, stderr=result.stderr)
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode(errors='replace')[-1500:]
        print(f'   解码校验失败（退出码 {error.returncode}），完整日志：{log_path}\n{detail}', flush=True)
        return False
    ensure_running()
    return True


def _cfr_durations(signatures):
    """Use frame duration when counts/durations match the nominal CFR rate."""
    durations = []
    for signature in signatures:
        video = _video_signature(signature)
        rate = _rate(video.get('r_frame_rate'))
        frames = _rate(video.get('nb_frames'))
        duration = _rate(video.get('duration'))
        if not rate or not frames or not duration or abs(frames / rate - duration) > .5 / rate:
            return None
        durations.append(frames / rate)
    return durations


def _verify_frame_timeline(output, signatures):
    durations = _cfr_durations(signatures)
    rates = [_rate(_video_signature(s).get('r_frame_rate')) for s in signatures]
    if durations is None or not rates or any(abs(r - rates[0]) > 1e-6 for r in rates):
        return True  # VFR: full decoding still runs, without imposing a CFR grid.
    points = []
    def collect(line):
        try:
            point = float(line.split(',')[0])
        except ValueError:
            return None
        points.append(point)
        return {'out_time_us': max(0, point - points[0]) * 1_000_000, 'frame': len(points)}
    try:
        with timed_stage('checking_timestamps', message='逐帧检查时间轴，确认无卡顿或跳帧'):
            probe = run_media_process(
                ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_packets',
                 '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', str(output)],
                duration=sum(durations), on_line=collect)
            if probe.returncode or probe.stderr.strip():
                raise ValueError('无法读取成片帧时间戳')
            expected = sum(int(_video_signature(s)['nb_frames']) for s in signatures)
            if len(points) != expected:
                raise ValueError(f'成片视频包数 {len(points)}，源片帧数合计 {expected}')
            points.sort()  # B-frame PTS reorder in packet order is normal.
            for index, point in enumerate(points):
                if abs(point - points[0] - index / rates[0]) > .5 / rates[0]:
                    raise ValueError(f'第 {index + 1} 帧（{point:.6f} 秒）偏离帧时间网格，可能卡顿或跳帧')
    except ValueError as error:
        print(f'   时间轴校验失败：{error}', flush=True)
        return False
    return True


def _verify_merge(output, signatures):
    # Match the duration directive used by concat. Audio tails in each source
    # container must not be counted again when the video frame grid sets starts.
    frame_durations = _cfr_durations(signatures)
    durations = (frame_durations if frame_durations is not None else
                 [_rate(_video_signature(s).get('container_duration')) for s in signatures])
    if durations and all(d is not None for d in durations):
        actual = _probe_stream_signature(output)
        if frame_durations is not None:
            duration = _rate(_video_signature(actual).get('duration'))
            rate = _rate(_video_signature(signatures[0]).get('r_frame_rate'))
            tolerance = max(.1, 2 / rate)
            label = '视频轨时长（按帧）'
        else:
            duration = _rate(_video_signature(actual).get('container_duration'))
            tolerance = max(2, len(durations) * .05)
            label = '容器时长'
        if duration is None or abs(duration - sum(durations)) > tolerance:
            print(f'   校验失败：成片{label} {duration} 秒，源片合计 {sum(durations):.3f} 秒')
            return False
    return _verify_video_decode(output) and _verify_frame_timeline(output, signatures)


def _repair_without_video_encoding(videos, signatures, merge_dir):
    """Repair only time bases/audio; retain every source video packet."""
    reference = _video_signature(signatures[0])
    if not all(_video_matches(_video_signature(s), reference, False) for s in signatures):
        return None
    audio_changes = any(_audio_signature(s) != _audio_signature(signatures[0]) for s in signatures)
    base = _rate(reference.get("time_base"))
    timescale = round(1 / base) if base else 0
    if not timescale or abs(timescale * base - 1) > 1e-6:
        return None
    prepared = []
    with timed_stage("normalizing", message="无损修复时间基准或音轨，保留原画面"):
        for index, (video, signature) in enumerate(zip(videos, signatures), 1):
            different_base = _video_signature(signature).get("time_base") != reference.get("time_base")
            if not audio_changes and not different_base:
                prepared.append(video)
                continue
            output = merge_dir / "repaired" / f"{index:04d}.mp4"
            output.parent.mkdir(parents=True, exist_ok=True)
            print(f"   无损修复 {index}/{len(videos)}：{video.name}（画面复制）")
            audio_args = ["-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "192k"] if audio_changes else ["-c:a", "copy"]
            _run_ffmpeg(["-i", str(video), "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy",
                         *audio_args, "-video_track_timescale", str(timescale), str(output)])
            prepared.append(output)
    return prepared


def _probe_video_target(path: Path) -> tuple[int, int, str]:
    if not shutil.which("ffprobe"):
        raise SystemExit("视频格式不一致，自动转码合并需要 ffprobe，请安装完整版 ffmpeg")
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,avg_frame_rate", "-of", "json", str(path)],
        check=True, capture_output=True, text=True, **hidden_process_options(),
    )
    stream = json.loads(result.stdout)["streams"][0]
    width = int(stream["width"])
    height = int(stream["height"])
    frame_rate = stream.get("avg_frame_rate", "25")
    if frame_rate in {"0/0", "N/A"}:
        frame_rate = "25"
    return width - width % 2, height - height % 2, frame_rate


def _choose_video_target(videos: list[Path]) -> tuple[int, int, str]:
    """选择像素数最小的源规格，避免为合并而放大低分辨率视频"""
    targets = [_probe_video_target(video) for video in videos]
    return min(targets, key=lambda target: target[0] * target[1])


H264_ENCODERS = [
    ("h264_nvenc", "NVIDIA NVENC", ["-c:v", "h264_nvenc", "-preset", "p4",
                                     "-cq", "20", "-b:v", "0"]),
    ("h264_amf", "AMD AMF", ["-c:v", "h264_amf", "-quality", "balanced",
                               "-rc", "cqp", "-qp_i", "20", "-qp_p", "22"]),
    ("h264_qsv", "Intel Quick Sync", ["-c:v", "h264_qsv", "-preset", "veryfast",
                                        "-global_quality", "20"]),
]
CPU_ENCODER = ("libx264", "CPU libx264", ["-c:v", "libx264", "-preset", "veryfast",
                                           "-crf", "20"])
HEVC_ENCODERS = [
    ("hevc_nvenc", "NVIDIA NVENC H.265", ["-c:v", "hevc_nvenc", "-preset", "p4", "-cq", "22", "-b:v", "0"]),
    ("hevc_amf", "AMD AMF H.265", ["-c:v", "hevc_amf", "-quality", "balanced", "-rc", "cqp", "-qp_i", "20", "-qp_p", "22"]),
    ("hevc_qsv", "Intel Quick Sync H.265", ["-c:v", "hevc_qsv", "-preset", "veryfast", "-global_quality", "22"]),
]
CPU_HEVC_ENCODER = ("libx265", "CPU libx265", ["-c:v", "libx265", "-preset", "veryfast", "-crf", "22"])


def _encoder_works(encoder_args: list[str], width: int, height: int,
                   frame_rate: str) -> bool:
    """用目标规格试编码两帧，确认编码器不仅存在，而且硬件和驱动确实可用"""
    try:
        result = subprocess.run([
        "ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi",
        "-i", f"color=c=black:s={width}x{height}:r={frame_rate}",
        "-frames:v", "2", "-vf", "format=nv12", *encoder_args,
        "-f", "null", "-",
        ], capture_output=True, stdin=subprocess.DEVNULL, timeout=15, **hidden_process_options())
    except subprocess.TimeoutExpired:
        print(f"[编码器检查] {encoder_args[1]} 15 秒内未响应，尝试其他编码器", flush=True)
        return False
    if result.returncode:
        detail = result.stderr.decode(errors='replace').strip().splitlines()
        print(f"[编码器检查] {encoder_args[1]} 不可用，尝试其他编码器或 CPU：{detail[0] if detail else '初始化失败'}", flush=True)
    return result.returncode == 0


def _select_h264_encoder(width: int, height: int,
                         frame_rate: str) -> tuple[str, str, list[str]]:
    for encoder in H264_ENCODERS:
        if _encoder_works(encoder[2], width, height, frame_rate):
            return encoder
    return CPU_ENCODER


def _select_merge_encoder(target):
    if target['codec_name'] == 'hevc':
        for encoder in HEVC_ENCODERS:
            if _encoder_works(encoder[2], target['width'], target['height'], target['r_frame_rate']):
                return encoder
        return CPU_HEVC_ENCODER
    return _select_h264_encoder(target['width'], target['height'], target['r_frame_rate'])


def _normalize_for_merge(source: Path, output: Path, width: int, height: int,
                         frame_rate: str, encoder_args: list[str], *, timescale=None,
                         pixel_format=None, sample_aspect_ratio='1:1', audio_rate=44100, audio_channels=2) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    cpu = any(name in encoder_args for name in ('libx264', 'libx265'))
    pixel_format = pixel_format or 'yuv420p'
    if not cpu:
        pixel_format = {'yuv420p': 'nv12', 'yuv420p10le': 'p010le'}.get(pixel_format, pixel_format)
    aspect = sample_aspect_ratio.replace(':', '/')
    video_filter = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar={aspect},"
        f"fps={frame_rate},format={pixel_format}"
    )
    partial = output.with_name(output.stem + ".partial.mp4")
    _run_ffmpeg([
        "-i", str(source), "-map", "0:v:0", "-map", "0:a:0", "-vf", video_filter,
        *encoder_args,
        "-c:a", "aac", "-b:a", "192k", "-ar", str(audio_rate), "-ac", str(audio_channels),
        *(["-video_track_timescale", str(timescale)] if timescale else []),
        str(partial),
    ])
    partial.replace(output)


def _prepare_merge_episodes(videos, plan, merge_dir, reuse_normalized, encoder_override=None):
    target = plan['target']
    pending = [e for e in plan['episodes'] if e['action'] != 'copy']
    if not pending:
        return videos
    prepared = []
    encode_total = plan['counts'].get('transcode', 0)
    with timed_stage("normalizing", message=f"仅处理 {len(pending)}/{len(videos)} 集，其中画面转码 {encode_total} 集"):
        encoder = (encoder_override or _select_merge_encoder(target)) if encode_total else None
        if encoder and plan.get('uniform_hevc'):
            # A common no-B-frame configuration prevents decoder reorder delays
            # from changing at segment boundaries.
            encoder = (encoder[0], encoder[1], [*encoder[2], '-bf', '0'])
        if encoder:
            print(f"   统一目标：{target['width']}×{target['height']} @ {target['r_frame_rate']}，"
                  f"编码器：{encoder[1]}；仅转码 {encode_total}/{len(videos)} 集")
        done = encoded = cached = 0
        for video, episode in zip(videos, plan['episodes']):
            if episode['action'] == 'copy':
                prepared.append(video)
                continue
            ensure_running()
            stat = video.stat()
            recipe = json.dumps([MERGE_PIPELINE_VERSION, str(video.resolve()), stat.st_size,
                                 stat.st_mtime_ns, target, episode['action'],
                                 encoder[2] if episode['action'] == 'transcode' else None], sort_keys=True)
            key = hashlib.sha256(recipe.encode('utf-8')).hexdigest()[:16]
            output = merge_dir / 'prepared' / f"{episode['index']:04d}-{key}.mp4"
            checkpoint = output.with_suffix('.done')
            valid = (reuse_normalized and output.exists() and output.stat().st_size > 0 and
                     checkpoint.exists() and checkpoint.read_text(encoding='utf-8') == key)
            with progress_context(completedItems=done, totalItems=len(pending),
                                  episodeIndex=episode['index'], episodeCount=len(videos),
                                  message=f"处理第 {episode['index']}/{len(videos)} 集：{video.name}"):
                if valid:
                    cached += 1
                    print(f"   复用第 {episode['index']} 集处理缓存：{video.name}")
                else:
                    output.parent.mkdir(parents=True, exist_ok=True)
                    checkpoint.unlink(missing_ok=True)
                    reason = '；'.join(episode['reasons'])
                    if episode['action'] == 'transcode':
                        encoded += 1
                        print(f"   转码 {encoded}/{encode_total}（原第 {episode['index']} 集）：{video.name}；原因：{reason}")
                        kwargs = dict(timescale=target['timescale'], pixel_format=target['pix_fmt'],
                                      sample_aspect_ratio=target['sample_aspect_ratio'],
                                      audio_rate=int(target['audio']['sample_rate']), audio_channels=target['audio']['channels'])
                        try:
                            _normalize_for_merge(video, output, target['width'], target['height'],
                                                 target['r_frame_rate'], encoder[2], **kwargs)
                        except PipelineStopped:
                            raise
                        except SystemExit:
                            if encoder[0] in ('libx264', 'libx265'):
                                raise
                            fallback = CPU_HEVC_ENCODER if target['codec_name'] == 'hevc' else CPU_ENCODER
                            if plan.get('uniform_hevc'):
                                print(f'   {encoder[1]} 失败，统一改用 {fallback[1]} 重做所有 H.265 片段，避免混用编码参数')
                                return _prepare_merge_episodes(videos, plan, merge_dir, reuse_normalized,
                                                               encoder_override=fallback)
                            print(f"   {encoder[1]} 失败，仅将第 {episode['index']} 集回退 {fallback[1]}")
                            _normalize_for_merge(video, output, target['width'], target['height'],
                                                 target['r_frame_rate'], fallback[2], **kwargs)
                    else:
                        print(f"   无损修复（原第 {episode['index']} 集）：{video.name}；原因：{reason}；画面复制")
                        partial = output.with_name(output.stem + '.partial.mp4')
                        audio_args = (["-c:a", "aac", "-b:a", "192k", "-ar", target['audio']['sample_rate'],
                                       "-ac", str(target['audio']['channels'])] if episode['audio_changes'] else ["-c:a", "copy"])
                        _run_ffmpeg(["-i", str(video), "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy",
                                     *audio_args, "-video_track_timescale", str(target['timescale']), str(partial)])
                        partial.replace(output)
                    checkpoint.write_text(key, encoding='utf-8')
            prepared.append(output)
            done += 1
            emit('normalizing', round(100 * done / len(pending), 1),
                 message=f"已处理 {done}/{len(pending)} 个异常片段；其余画面直接复制")
        if cached:
            print(f"   已复用 {cached} 个完整处理缓存")
    return prepared


def merge_videos(videos: list[Path], output: Path, work_dir: Path,
                 reuse_normalized: bool = True) -> None:
    """Copy compatible streams; explicitly unify incompatible HEVC parameters."""
    if not videos:
        raise SystemExit("没有可合并的视频")
    output.parent.mkdir(parents=True, exist_ok=True)
    merge_dir = work_dir / "merge" / compute_input_hash(output)
    merge_dir.mkdir(parents=True, exist_ok=True)
    with timed_stage("probing", message=f"分析 {len(videos)} 集拼接兼容性"):
        signatures = []
        for index, video in enumerate(videos, 1):
            ensure_running()
            signatures.append(_probe_stream_signature(video))
            emit('probing', round(100 * index / len(videos), 1), completedItems=index,
                 totalItems=len(videos), message=f'已分析 {index}/{len(videos)} 集')
        for video, signature in zip(videos, signatures):
            if signature is not None and (not _video_signature(signature) or
                    not any(s.get("codec_type") == "audio" for s in signature)):
                raise SystemExit(f"视频缺少画面或音轨，无法分离：{video.name}")
    if any(s is None for s in signatures):
        raise SystemExit('安全拼接需要 ffprobe 检查编码参数，请安装完整版 ffmpeg；已停止，未生成未校验成片')

    plan = build_merge_plan(videos, signatures)
    plan['target'].pop('container_duration', None)
    plan_path = merge_dir / 'merge_plan.json'
    plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding='utf-8')
    counts = plan['counts']
    if plan.get('uniform_hevc'):
        print('   安全模式：H.265 参数集不一致，必须统一全剧编码；不混拼原片与转码片段')
    print(f"   拼接计划：直接复制 {counts.get('copy', 0)} 集，重封装 {counts.get('remux', 0)} 集，"
          f"仅修复音轨 {counts.get('audio', 0)} 集，画面转码 {counts.get('transcode', 0)} 集")
    print(f"   逐集计划：{plan_path.resolve()}")
    for episode in plan['episodes']:
        if episode['action'] != 'copy':
            print(f"   第 {episode['index']} 集：{'；'.join(episode['reasons'])}")
    prepared = _prepare_merge_episodes(videos, plan, merge_dir, reuse_normalized)
    with timed_stage('probing', message='复核已处理片段的编码参数'):
        prepared_signatures = []
        for index, video in enumerate(prepared, 1):
            ensure_running()
            prepared_signatures.append(_probe_stream_signature(video))
            emit('probing', round(100 * index / len(prepared), 1), completedItems=index,
                 totalItems=len(prepared), message=f'已复核 {index}/{len(prepared)} 集')
    if plan['target']['codec_name'] == 'hevc':
        hashes = [_video_signature(s).get('extradata_hash') for s in prepared_signatures]
        if not all(hashes) or len(set(hashes)) != 1:
            raise SystemExit(f'H.265 处理后的参数集仍不一致，已停止，未拼接或上传。保留逐集计划：{plan_path}')
    durations = _cfr_durations(prepared_signatures)
    # Publish only a validated result. A failed partial is retained for diagnosis.
    partial = output.with_name(output.stem + '.partial.mp4')
    merge_duration = sum(durations) if durations else sum(_rate(_video_signature(signature).get('container_duration')) or 0 for signature in prepared_signatures)
    with timed_stage("merging", durationSeconds=merge_duration,
                     message=f"合并 {len(videos)} 集；{counts.get('transcode', 0)} 集需转码，其余保留原画面"):
        concat_args = (prepared, partial, merge_dir / 'concat.txt')
        success = (_run_concat_copy(*concat_args, durations) if durations is not None
                   else _run_concat_copy(*concat_args))
        if not success or not _verify_merge(partial, prepared_signatures):
            raise SystemExit(f"拼接或成片校验失败，已停止，未自动整剧转码。请提供逐集计划及上述错误：{plan_path.resolve()}")
        partial.replace(output)
        print(f"   拼接完成并通过校验：画面直接复制 {len(videos) - counts.get('transcode', 0)} 集，"
              f"仅转码 {counts.get('transcode', 0)} 集")


def extract_thumbnail_frame(input_video: Path, out_jpg: Path) -> None:
    """截取第 1 秒画面作为缩略图（1280 宽，符合 YouTube 要求）"""
    out_jpg.parent.mkdir(parents=True, exist_ok=True)
    _run_ffmpeg(["-ss", "1", "-i", str(input_video), "-frames:v", "1",
                 "-vf", "scale=1280:-2", str(out_jpg)])


def probe_readable(path: Path) -> bool:
    """探测文件是否可被 ffmpeg 读取；无 ffprobe 时用 ffmpeg 试读前 0.5 秒"""
    if path.suffix.lower() in SUPPORTED_EXTENSIONS:
        return True
    if shutil.which("ffprobe"):
        r = subprocess.run(["ffprobe", "-v", "error", "-i", str(path),
                            "-show_entries", "format=duration", "-of", "csv=p=0"],
                           capture_output=True, **hidden_process_options())
        return r.returncode == 0
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-t", "0.5",
                       "-f", "null", "-"], capture_output=True, **hidden_process_options())
    return r.returncode == 0


def separate_vocals(wav: Path, out_dir: Path, fast: bool = False) -> Path:
    """隔离运行 Demucs，只保存人声并透传模型加载和推理进度"""
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, "-u", str(Path(__file__).with_name("separation_worker.py")), str(wav), str(out_dir)]
    if fast:
        cmd += ["--fast"]
    try:
        subprocess.run(cmd, check=True, env={**os.environ, "PYTHONIOENCODING": "utf-8"}, **hidden_process_options())
    except subprocess.CalledProcessError as e:
        detail = e.stderr.decode(errors="replace")[-500:] if e.stderr else str(e)
        raise SystemExit(f"demucs 分离失败：{detail}")
    vocals = out_dir / "htdemucs" / wav.stem / "vocals.wav"
    if not vocals.exists():
        raise SystemExit(f"demucs 未产出预期文件：{vocals}")
    return vocals


SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]


def apply_proxy(proxy: str) -> None:
    """Explicit settings override inherited proxies and bypass rules; empty means direct."""
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
                 "ALL_PROXY", "all_proxy"):
        os.environ.pop(name, None)
    if proxy:
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
            os.environ[name] = proxy
    # requests also falls back to the Windows system proxy. '*' disables that
    # fallback for direct mode; explicit proxies must not bypass Google hosts.
    bypass = "localhost,127.0.0.1,::1" if proxy else "*"
    for name in ("NO_PROXY", "no_proxy"):
        os.environ[name] = bypass


def find_client_secret(cli_path: Path | None, script_dir: Path) -> Path:
    """凭据查找顺序：--client-secret > data/credentials > 旧版根目录。

    显式指定 --client-secret 时该路径必须存在，否则立即报错（防止静默用错凭据）"""
    if cli_path is not None:
        if cli_path.exists():
            return cli_path
        raise FileNotFoundError(f"指定的 client_secret.json 不存在：{cli_path}")
    project_secret = credential_path(script_dir, "client_secret.json")
    if project_secret.exists():
        return project_secret
    raise FileNotFoundError("找不到 client_secret.json：请把 OAuth 桌面应用凭据"
                            "复制到 data/credentials，或用 --client-secret 指定")


def validate_client_secret(path: Path) -> None:
    """校验凭据是"桌面应用"类型，避免用错 Web 客户端凭据"""
    data = json.loads(path.read_text(encoding="utf-8"))
    if "installed" not in data:
        raise SystemExit(f"{path} 不是桌面应用凭据（缺少 installed 字段）"
                         "请在 Google Cloud 控制台创建『桌面应用』类型的 OAuth 客户端")


def get_authenticated_service(client_secret: Path, token_path: Path, allow_interactive=True):
    """OAuth 2.0：优先用缓存 token，过期自动刷新，否则弹浏览器授权"""
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from googleapiclient.discovery import build
    from google.auth.transport.requests import Request
    from google.auth.exceptions import RefreshError

    creds = None
    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
            except RefreshError:
                print("token 已失效，需要重新授权…")
                creds = None
        if not creds or not creds.valid:
            if not allow_interactive:
                raise SystemExit("所选上传账号的授权缺失或已失效，请在服务设置中选择该账号并更新授权信息后重试")
            flow = InstalledAppFlow.from_client_secrets_file(str(client_secret), SCOPES)
            creds = flow.run_local_server(port=0)
        from oauth_service import save_token
        save_token(token_path, json.loads(creds.to_json()))
    return build("youtube", "v3", credentials=creds)


def upload_video(youtube, file_path: Path, title: str, description: str,
                 tags: list[str], privacy: str, retries: int = 3, checkpoint_path: Path | None = None):
    """断点续传上传；5xx 网络错误重试（同一请求对象续传），返回 (video_id, 链接)。"""
    from googleapiclient.errors import HttpError
    from googleapiclient.http import MediaFileUpload

    body = {
        "snippet": {"title": title, "description": description, "tags": tags},
        "status": {"privacyStatus": privacy, "selfDeclaredMadeForKids": False},
    }
    ensure_running()
    emit("uploading", 0, message=title)
    total_bytes = file_path.stat().st_size
    state = {'file': str(file_path.resolve()), 'size': total_bytes, 'mtime': file_path.stat().st_mtime_ns}
    if checkpoint_path and checkpoint_path.exists():
        try:
            saved = json.loads(checkpoint_path.read_text(encoding='utf-8'))
            if saved.get('video_id'):
                return saved['video_id'], f"https://youtu.be/{saved['video_id']}"
            if any(saved.get(key) != value for key, value in state.items()):
                raise ValueError('上传文件已变化')
            if not saved.get('uri'):
                raise ValueError('上次上传会话创建结果不明')
            state = saved
        except (ValueError, OSError, AttributeError) as exc:
            raise SystemExit(f'无法安全恢复上传：{exc}。请先在 YouTube 核对视频，避免重复上传')
    started = time.monotonic()
    media = MediaFileUpload(str(file_path), chunksize=8 * 1024 * 1024, resumable=True)
    request = youtube.videos().insert(part="snippet,status", body=body, media_body=media)
    # Slug supplies the original filename separately from the video's title.
    # Percent-encode UTF-8 so Chinese names remain valid HTTP header values.
    request.headers['Slug'] = quote(file_path.name, safe='')
    if checkpoint_path:
        _atomic_json(checkpoint_path, state)
        request.http = _UploadCheckpointTransport(request.http, checkpoint_path, state)
        if state.get('uri'):
            request.resumable_uri = state['uri']
            request._in_error_state = True  # Query committed bytes (or final result) first.
            print('恢复原 YouTube 上传会话，查询服务器进度…')
    response = None
    for attempt in range(retries):
        try:
            while response is None:
                ensure_running()
                status, response = request.next_chunk()
                if status:
                    print(f"上传进度: {int(status.progress() * 100)}%")
                    transferred = total_bytes * status.progress()
                    speed = transferred / max(time.monotonic() - started, .001)
                    seconds = int((total_bytes - transferred) / speed) if speed > 0 else 0
                    emit("uploading", round(status.progress() * 100, 2), transferredBytes=int(transferred),
                         totalBytes=total_bytes, speedText=f"{speed / 1024 / 1024:.2f} MB/s",
                         etaText=f"{seconds // 60:02d}:{seconds % 60:02d}")
            if checkpoint_path:
                state['video_id'] = response['id']
                _atomic_json(checkpoint_path, state)
            return response["id"], f"https://youtu.be/{response['id']}"
        except HttpError as e:
            if checkpoint_path and e.resp.status in (404, 410):
                raise SystemExit('原 YouTube 上传会话已失效，已停止自动新建上传。请在 YouTube 核对是否已生成视频，避免重复上传')
            if e.resp.status >= 500 and attempt < retries - 1:
                print(f"上传出错（HTTP {e.resp.status}），{2 ** attempt} 秒后重试…")
                time.sleep(2 ** attempt)
                continue
            raise SystemExit(f"上传失败（HTTP {e.resp.status}）：5xx 重试已耗尽，或存在配额/权限类错误，"
                             "请检查网络与 YouTube API 配额后重试")
        except OSError as e:
            if attempt < retries - 1:
                print(f"网络错误（{e}），{2 ** attempt} 秒后重试…")
                time.sleep(2 ** attempt)
                continue
            raise SystemExit(f"上传失败：网络连接错误（{e}）。请检查网络或代理设置"
                             "（可用 --proxy 指定代理，如 --proxy http://127.0.0.1:7890）")
    raise SystemExit("上传失败：重试次数已用完")


def set_thumbnail(youtube, video_id: str, thumb_jpg: Path) -> None:
    from googleapiclient.http import MediaFileUpload

    ensure_running()
    youtube.thumbnails().set(videoId=video_id,
                             media_body=MediaFileUpload(str(thumb_jpg))).execute()


def process_video(video: Path, args, work_dir: Path) -> Path:
    """对单个视频执行音轨提取、人声分离和重混"""
    if not probe_readable(video):
        print(f"无法读取该格式：{video.suffix}（支持 {sorted(SUPPORTED_EXTENSIONS)}，"
              "或安装新版 ffmpeg）")
        raise SystemExit(1)

    wav_path, separate_out, vocals_path, _ = cache_paths(video, work_dir)
    out_video = video.with_name(f"{video.stem}_人声版.mp4")
    if getattr(args, 'temporary_outputs', False):
        output_dir = work_dir / 'outputs' / compute_input_hash(video)
        output_dir.mkdir(parents=True, exist_ok=True)
        out_video = output_dir / out_video.name
    guarded = bool(os.environ.get("DRAMAVOX_TASK_ID"))
    checkpoints = work_dir / "checkpoints" / compute_input_hash(video)
    separated_done = checkpoints / "separated.done"
    remuxed_done = checkpoints / "remuxed.done"
    signature = f"{video.stat().st_size}:{video.stat().st_mtime_ns}:{separation_signature(args.fast)}"

    def valid_checkpoint(path):
        return path.exists() and path.read_text(encoding="utf-8") == signature

    legacy_cache = not guarded and not args.fast and not separated_done.exists()
    separation_needed = args.force or not vocals_path.exists() or (not legacy_cache and not valid_checkpoint(separated_done))

    if separation_needed:
        if guarded:
            separated_done.unlink(missing_ok=True)
        if args.force or not wav_path.exists() or wav_path.stat().st_mtime_ns < video.stat().st_mtime_ns:
            with timed_stage("extracting", message=video.name):
                print("① 提取音轨…")
                extract_audio(video, wav_path)
        else:
            print("① 检测到完整音轨缓存，跳过重复提取")
        print("② Demucs 人声分离…")
        separate_vocals(wav_path, separate_out, args.fast)
        checkpoints.mkdir(parents=True, exist_ok=True)
        separated_done.write_text(signature, encoding="utf-8")
    else:
        print("② 检测到分离缓存，跳过 demucs（--force 可重做）")
    if args.force or separation_needed or not out_video.exists() or (guarded and not valid_checkpoint(remuxed_done)):
        if guarded:
            remuxed_done.unlink(missing_ok=True)
        with timed_stage("remuxing", message=video.name):
            print("③ 重混：原画面 + 人声轨…")
            remux_video(video, vocals_path, out_video)
        if guarded:
            checkpoints.mkdir(parents=True, exist_ok=True)
            remuxed_done.write_text(signature, encoding="utf-8")
    print(f"✅ 已生成：{out_video}")
    return out_video


def _upload_processed_video(youtube, source: Path, output: Path, thumbnail_source: Path,
                            title: str, args, script_dir: Path, work_dir: Path,
                            upload_key: str | None = None) -> bool:
    """上传一个已处理视频；返回是否实际执行了上传"""
    key = upload_key or compute_input_hash(source)
    log_path = _upload_log_path(args, script_dir)
    if is_uploaded(log_path, key) and not args.force_upload:
        print(f"{output.name} 已上传过，跳过上传（--force-upload 可强制再传）")
        return False

    with timed_stage("uploading", message=title):
        print(f"④ 上传中：{title}（隐私：{args.privacy}）")
        checkpoint = log_path.parent / (log_path.stem + '-sessions') / f'{key}.json'
        if args.force_upload:
            checkpoint.unlink(missing_ok=True)
        video_id, url = upload_video(youtube, output, title, args.description,
                                     args.tags, args.privacy, checkpoint_path=checkpoint)
    mark_uploaded(log_path, key, video_id)

    _, _, _, thumb_path = cache_paths(thumbnail_source, work_dir)
    try:
        with timed_stage("thumbnail"):
            extract_thumbnail_frame(thumbnail_source, thumb_path)
            set_thumbnail(youtube, video_id, thumb_path)
        print("缩略图已设置")
    except PipelineStopped:
        raise
    except (SystemExit, Exception) as e:
        from googleapiclient.errors import HttpError
        if isinstance(e, HttpError) and getattr(e.resp, "status", None) == 403:
            print("缩略图设置失败（不影响视频本体）：账号未验证手机号，暂无自定义缩略图权限"
                  "（完成手机验证后自动解锁）")
        else:
            print(f"缩略图设置失败（不影响视频本体）：{e}")
    print(f"✅ 上传成功：{url}")
    return True


def _batch_signature(videos: list[Path]) -> str:
    items = []
    for video in videos:
        stat = video.stat()
        items.append((str(video.resolve()), stat.st_size, stat.st_mtime_ns))
    return hashlib.sha256(json.dumps(items, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]


def _get_youtube_service(args, script_dir: Path):
    with timed_stage("authorizing", message="准备 YouTube 授权与连接"):
        client_secret = find_client_secret(args.client_secret, script_dir)
        validate_client_secret(client_secret)
        token_path = getattr(args, 'token_file', None) or credential_path(script_dir, "token.json")
        if getattr(args, 'no_browser_auth', False):
            return get_authenticated_service(client_secret, token_path, allow_interactive=False)
        return get_authenticated_service(client_secret, token_path)


def _upload_log_path(args, script_dir):
    return getattr(args, 'upload_log', None) or credential_path(script_dir, 'uploaded.json')


def _main_muted(source, videos, args, work_dir, script_dir):
    signature = _batch_signature(videos)
    output = source.with_name(f"{source.stem if source.is_file() else source.name}_静音版.mp4")
    if source.is_dir():
        output = source / output.name
    if getattr(args, "temporary_outputs", False):
        output_dir = work_dir / "outputs"
        output_dir.mkdir(parents=True, exist_ok=True)
        output = output_dir / output.name
    cache = work_dir / "merge" / compute_input_hash(source)
    cache.mkdir(parents=True, exist_ok=True)
    manifest = cache / "mute_manifest.json"
    settings = [signature, MERGE_PIPELINE_VERSION, "mute-v1", args.compress]
    if (args.force or not output.is_file() or not manifest.is_file()
            or manifest.read_text(encoding="utf-8") != json.dumps(settings, indent=2)):
        manifest.unlink(missing_ok=True)
        partial = output.with_name(output.stem + ".partial.mp4")
        with TemporaryDirectory(prefix="mute-", dir=cache) as temp:
            temporary = Path(temp)
            merged = videos[0]
            if len(videos) > 1:
                prepared = []
                for index, video in enumerate(videos):
                    streams = _probe_stream_signature(video)
                    if streams and not any(stream.get("codec_type") == "audio" for stream in streams):
                        silent = temporary / f"{index}.mp4"
                        _run_ffmpeg(["-i", str(video), "-f", "lavfi", "-i",
                                     "anullsrc=r=44100:cl=stereo", "-map", "0:v:0",
                                     "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac",
                                     "-shortest", str(silent)])
                        video = silent
                    prepared.append(video)
                merged = temporary / "merged.mp4"
                merge_videos(prepared, merged, temporary, reuse_normalized=False)
            with timed_stage("muting", message=source.name):
                _run_ffmpeg(["-i", str(merged), "-map", "0:v:0", "-an",
                             "-c:v", "copy", "-movflags", "+faststart", str(partial)])
            if args.compress:
                compressed = output.with_name(output.stem + ".compressed.partial.mp4")
                with timed_stage("compressing", message=source.name):
                    _run_ffmpeg(["-i", str(partial), "-map", "0:v:0", "-an",
                                 "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                                 "-movflags", "+faststart", str(compressed)])
                    if compressed.stat().st_size < partial.stat().st_size:
                        compressed.replace(partial)
                    else:
                        compressed.unlink()
            partial.replace(output)
        _atomic_json(manifest, settings)
    print(f"✅ 静音版已生成：{output}")
    if not args.no_upload:
        upload_key = f"mute-{signature}"
        if not is_uploaded(_upload_log_path(args, script_dir), upload_key) or args.force_upload:
            youtube = _get_youtube_service(args, script_dir)
            _upload_processed_video(youtube, source, output, videos[0],
                                    args.title or default_title(source), args,
                                    script_dir, work_dir, upload_key)
    return output


def _main_single(video: Path, args, work_dir: Path, script_dir: Path):
    out_video = process_video(video, args, work_dir)
    if args.no_upload:
        print("（--no-upload，跳过上传）")
        return out_video

    key = compute_input_hash(video)
    if is_uploaded(_upload_log_path(args, script_dir), key) and not args.force_upload:
        print("该视频已上传过，跳过上传（--force-upload 可强制再传）")
        return out_video
    youtube = _get_youtube_service(args, script_dir)
    _upload_processed_video(youtube, video, out_video, video,
                            args.title or default_title(video), args, script_dir, work_dir, key)
    return out_video


def _main_batch(directory: Path, args, work_dir: Path, script_dir: Path):
    videos = discover_videos(directory, recursive=args.recursive)
    if not videos:
        print(f"目录中没有支持的视频：{directory}")
        raise SystemExit(1)

    print(f"发现 {len(videos)} 集，将按以下顺序处理：")
    for index, video in enumerate(videos, start=1):
        print(f"  {index}. {video.name}")

    if args.mute:
        return _main_muted(directory, videos, args, work_dir, script_dir)

    if args.merge:
        merged = directory / f"{directory.name}_全集_人声版.mp4"
        if getattr(args, 'temporary_outputs', False):
            output_dir = work_dir / 'outputs'
            output_dir.mkdir(parents=True, exist_ok=True)
            merged = output_dir / merged.name
        signature = _batch_signature(videos)
        source_signature = f"{signature}:{MERGE_PIPELINE_VERSION}"
        processing_signature = f"{source_signature}:{separation_signature(args.fast)}"
        batch_dir = work_dir / "merge" / compute_input_hash(directory)
        source_merged = batch_dir / "全集_原片.mp4"
        manifest = batch_dir / "manifest.txt"
        separation_manifest = batch_dir / "separation_manifest.txt"
        output_manifest = batch_dir / "output_manifest.txt"
        cached_signature = manifest.read_text(encoding="utf-8") if manifest.exists() else ""
        source_changed = (args.force or not source_merged.exists()
                          or cached_signature != source_signature)

        if source_changed:
            manifest.unlink(missing_ok=True)
            print(f"\n===== 先合并 {len(videos)} 集原片 =====")
            merge_videos(videos, source_merged, work_dir,
                         reuse_normalized=not args.force)
            manifest.parent.mkdir(parents=True, exist_ok=True)
            manifest.write_text(source_signature, encoding="utf-8")
        else:
            print("检测到原片合并缓存，跳过合并（--force 可重做）")

        wav_path, separate_out, vocals_path, _ = cache_paths(source_merged, work_dir)
        cached_separation = (separation_manifest.read_text(encoding="utf-8")
                             if separation_manifest.exists() else "")
        separation_changed = (source_changed or args.force or not vocals_path.exists()
                              or cached_separation != processing_signature)
        if separation_changed:
            if source_changed or not wav_path.exists():
                with timed_stage("extracting", message=directory.name):
                    print("① 提取全集音轨…")
                    extract_audio(source_merged, wav_path)
            else:
                print("① 检测到全集音轨缓存，跳过重复提取")
            print("② Demucs 分离全集人声…（只加载一次模型）")
            separation_manifest.unlink(missing_ok=True)
            separate_vocals(wav_path, separate_out, args.fast)
            separation_manifest.write_text(processing_signature, encoding="utf-8")
        else:
            print("② 检测到全集分离缓存，跳过 Demucs（--force 可重做）")

        cached_output = (output_manifest.read_text(encoding="utf-8")
                         if output_manifest.exists() else "")
        if separation_changed or args.force or not merged.exists() or cached_output != processing_signature:
            output_manifest.unlink(missing_ok=True)
            with timed_stage("remuxing", message=directory.name):
                print("③ 重混：全集画面 + 全集人声轨…")
                remux_video(source_merged, vocals_path, merged)
            output_manifest.write_text(processing_signature, encoding="utf-8")
        else:
            print("检测到全集重混缓存，跳过重混（--force 可重做）")
        print(f"✅ 全集已生成：{merged}")

        if args.no_upload:
            print("（--no-upload，跳过上传）")
            return merged
        upload_key = f"batch-{signature}"
        if is_uploaded(_upload_log_path(args, script_dir), upload_key) and not args.force_upload:
            print("该全集已上传过，跳过上传（--force-upload 可强制再传）")
            return merged
        youtube = _get_youtube_service(args, script_dir)
        _upload_processed_video(youtube, directory, merged, videos[0],
                                args.title or f"{directory.name} 全集", args,
                                script_dir, work_dir, upload_key)
        return merged

    outputs = []
    for index, video in enumerate(videos, start=1):
        print(f"\n===== 处理第 {index}/{len(videos)} 集：{video.name} =====")
        outputs.append(process_video(video, args, work_dir))

    if args.no_upload:
        print(f"\n✅ 批量处理完成，共生成 {len(outputs)} 个视频（--no-upload，跳过上传）")
        return outputs

    youtube = None
    for video, output in zip(videos, outputs):
        key = compute_input_hash(video)
        if is_uploaded(_upload_log_path(args, script_dir), key) and not args.force_upload:
            print(f"{video.name} 已上传过，跳过上传")
            continue
        if youtube is None:
            youtube = _get_youtube_service(args, script_dir)
        title = f"{args.title} - {video.stem}" if args.title else default_title(video)
        _upload_processed_video(youtube, video, output, video, title, args,
                                script_dir, work_dir, key)
    return outputs


def main(argv=None, work_dir: Path | None = None):
    args = parse_args(argv)
    if args.proxy is not None:
        apply_proxy(args.proxy)
    input_path: Path = args.input
    if not input_path.exists():
        print(f"输入文件或目录不存在：{input_path}")
        raise SystemExit(1)

    script_dir = ROOT
    work_dir = args.work_dir or work_dir or script_dir / "work"
    args.temporary_outputs = bool(args.work_dir)
    if args.work_dir:
        from task_workspaces import TaskWorkspaces, task_lease
        workspaces = TaskWorkspaces(None, ROOT)
        if work_dir.absolute() != workspaces.path(args.task_id):
            raise ValueError('任务临时目录不在允许范围内')
        with task_lease(ROOT, args.task_id, wait=True):
            workspaces.validate(work_dir, args.task_id)
            return dispatch_input(input_path, args, work_dir, script_dir)
    return dispatch_input(input_path, args, work_dir, script_dir)


def dispatch_input(input_path, args, work_dir, script_dir):
    for tool in ('ffmpeg', 'ffprobe'):
        executable = shutil.which(tool)
        if not executable:
            raise SystemExit(f'未找到 {tool}，请重新检查运行环境')
        result = subprocess.run([executable, '-version'], stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=10, **hidden_process_options())
        version = (result.stdout or result.stderr).splitlines()
        print(f"[媒体工具] {version[0] if version else tool}；路径：{executable}", flush=True)
    if input_path.is_dir():
        return _main_batch(input_path, args, work_dir, script_dir)
    if args.batch or args.merge:
        print("--batch/--merge 需要输入目录")
        raise SystemExit(1)
    if args.mute:
        return _main_muted(input_path, [input_path], args, work_dir, script_dir)
    return _main_single(input_path, args, work_dir, script_dir)


if __name__ == "__main__":
    main()
