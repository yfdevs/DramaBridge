"""Choose one existing stream specification and prepare only incompatible episodes."""
from collections import Counter
from fractions import Fraction

MERGE_PIPELINE_VERSION = 'merge-safe-hevc-v6'


def number(value):
    try:
        result = float(Fraction(str(value)))
        return result if result > 0 else None
    except (ValueError, ZeroDivisionError):
        return None


def fps(stream):
    for field in ('r_frame_rate', 'avg_frame_rate'):
        if number(stream.get(field)):
            return stream[field]
    return '25/1'


def sar(stream):
    value = stream.get('sample_aspect_ratio')
    return value if number(str(value).replace(':', '/')) else '1:1'


def video_differences(source, target):
    reasons = []
    for field, label in [('codec_name', '视频编码'), ('width', '宽度'), ('height', '高度'), ('pix_fmt', '像素格式')]:
        if source.get(field) != target.get(field):
            reasons.append(f'{label} {source.get(field)} → {target.get(field)}')
    if Fraction(sar(source).replace(':', '/')) != Fraction(sar(target).replace(':', '/')):
        reasons.append(f'像素宽高比 {sar(source)} → {sar(target)}')
    if abs(number(fps(source)) - number(fps(target))) > .05:
        reasons.append(f'标称帧率 {fps(source)} → {fps(target)}')
    # H.264/HEVC carry parameter sets; profile/level alone do not justify re-encoding.
    # The assembled output is decode-checked before it can become a cache entry.
    if source.get('codec_name') not in {'h264', 'hevc'}:
        for field in ('profile', 'level'):
            if source.get(field) != target.get(field):
                reasons.append(f'{field} {source.get(field)} → {target.get(field)}')
    return reasons


def _stream(signature, kind):
    return next((s for s in signature if s.get('codec_type') == kind), {})


def build_merge_plan(videos, signatures):
    video_streams = [_stream(s, 'video') for s in signatures]
    audio_streams = [_stream(s, 'audio') for s in signatures]
    groups = {}
    for i, video in enumerate(video_streams):
        key = (video.get('codec_name'), video.get('width'), video.get('height'), video.get('pix_fmt'),
               sar(video), round(number(fps(video)), 1))
        groups.setdefault(key, []).append(i)
    # Keep the largest compatible group; prefer preserving more footage on a tie.
    indices = max(groups.values(), key=lambda group: (len(group), sum(
        number(video_streams[i].get('container_duration')) or 0 for i in group)))
    target = dict(video_streams[indices[0]])
    target['r_frame_rate'] = fps(target)
    target['sample_aspect_ratio'] = sar(target)
    if target.get('codec_name') not in {'h264', 'hevc'} and any(video_differences(s, target) for s in video_streams):
        target.update(codec_name='h264', pix_fmt='yuv420p')
    bases = Counter(s.get('time_base') for s in (video_streams[i] for i in indices))
    base = number(bases.most_common(1)[0][0])
    timescale = round(1 / base) if base else 15360
    if not base or abs(timescale * base - 1) > 1e-6:
        timescale = 15360
    target['time_base'] = f'1/{timescale}'
    target['timescale'] = timescale

    audio_groups = Counter((s.get('codec_name'), s.get('sample_rate'), s.get('channels'), s.get('profile')) for s in audio_streams)
    codec, rate, channels, profile = audio_groups.most_common(1)[0][0]
    if codec != 'aac' or channels not in (1, 2) or profile not in (None, 'LC'):
        codec, rate, channels, profile = 'aac', '44100', 2, 'LC'
    rate = int(number(rate) or 44100)
    target['audio'] = dict(codec_name=codec, sample_rate=str(rate), channels=channels, profile=profile, time_base=f'1/{rate}')

    episodes = []
    for index, (path, video, audio) in enumerate(zip(videos, video_streams, audio_streams), 1):
        reasons = video_differences(video, target)
        audio_changes = any(audio.get(key) != target['audio'].get(key)
                            for key in ('codec_name', 'sample_rate', 'channels', 'profile'))
        base_changes = number(video.get('time_base')) != number(target['time_base'])
        audio_base_changes = number(audio.get('time_base')) != number(target['audio']['time_base'])
        action = 'transcode' if reasons else 'audio' if audio_changes else 'remux' if base_changes or audio_base_changes else 'copy'
        if base_changes:
            reasons.append(f"视频时间基准 {video.get('time_base')} → {target['time_base']}（无损重封装）")
        if audio_changes:
            reasons.append(f"音轨 {audio.get('codec_name')}/{audio.get('sample_rate')}/{audio.get('channels')} → AAC/{rate}/{channels}")
        if audio_base_changes and not audio_changes:
            reasons.append('音频时间基准不同（无损重封装）')
        episodes.append(dict(index=index, path=str(path), action=action, audio_changes=audio_changes, reasons=reasons))
    # MP4 concat does not inject each HEVC input's VPS/SPS/PPS. Basic stream
    # dimensions/profile are insufficient to establish copy compatibility.
    hashes = [s.get('extradata_hash') for s in video_streams]
    uniform_hevc = target['codec_name'] == 'hevc' and (
        any(e['action'] == 'transcode' for e in episodes) or
        not all(hashes) or len(set(hashes)) != 1)
    if uniform_hevc:
        for episode in episodes:
            episode['action'] = 'transcode'
            episode['reasons'].append('H.265 参数集不一致或需混合转码，统一编码以避免拼接花屏及重排异常')
    return dict(version=MERGE_PIPELINE_VERSION, target=target, episodes=episodes,
                uniform_hevc=uniform_hevc,
                counts=dict(Counter(e['action'] for e in episodes)))
