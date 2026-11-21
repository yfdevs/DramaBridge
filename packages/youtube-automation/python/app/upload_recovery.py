"""Reconcile durable upload state with the resumable-upload server."""
import hashlib
import json
import time

from pipeline_events import ensure_running
from pipeline_failure import PipelineFailure


def file_identity(path):
    digest = hashlib.sha256()
    before = path.stat()
    with path.open('rb') as stream:
        while chunk := stream.read(8 * 1024 * 1024):
            ensure_running()
            digest.update(chunk)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError('上传文件在检查期间发生变化，请等待文件生成完成后重试')
    return dict(file=str(path.resolve()), size=after.st_size, mtime=after.st_mtime_ns,
                sha256=digest.hexdigest(), checkpoint_version=2)


def pending_result(reason):
    return PipelineFailure(dict(code='UPLOAD_RESULT_UNCONFIRMED', title='上传结果待确认',
        reason=reason, action='稍后重试，程序会重新查询原会话；若仍无法确认，请到 YouTube Studio 核对。',
        stage='uploading'))


def session_status(http, state):
    ensure_running()
    # No media bytes are sent by this request.
    for attempt in range(3):
        ensure_running()
        try:
            response, content = http.request(state['uri'], method='PUT', body=b'',
                headers={'Content-Length': '0', 'Content-Range': f"bytes */{state['size']}"})
            status = int(response.status)
        except OSError:
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)
            continue
        if status not in (408, 429, 500, 502, 503, 504) or attempt == 2:
            break
        time.sleep(2 ** attempt)
    if status in (200, 201):
        try:
            video_id = json.loads(content).get('id')
        except (ValueError, AttributeError):
            video_id = None
        if not isinstance(video_id, str) or not video_id:
            raise pending_result('服务器已接收上传，但返回结果中没有视频编号。')
        return 'complete', video_id
    if status == 308:
        return 'incomplete', None
    if status in (404, 410):
        return 'expired', None
    raise pending_result(f'上传进度查询返回 HTTP {status}，暂不创建重复上传。')


def recover_upload_state(saved, current, http):
    if not isinstance(saved, dict) or not isinstance(saved.get('size'), int) or saved['size'] <= 0:
        raise pending_result('原上传记录不完整，无法确认服务器结果。')
    if saved.get('video_id'):
        return saved
    if not saved.get('uri'):
        # Our transport saves Location before allowing any media PUT.
        if saved.get('bytes_attempted') or saved.get('completion_pending'):
            raise pending_result('原上传记录缺少会话地址，但可能已发送视频数据。')
        print('原会话尚未开始发送视频，自动重新创建上传会话', flush=True)
        return dict(current)
    try:
        status, video_id = session_status(http, saved)
    except OSError as error:
        raise pending_result('暂时无法查询原上传会话，请检查网络后重试。') from error
    if status == 'complete':
        print('服务器确认原视频已上传，复用视频编号', flush=True)
        return {**saved, 'video_id': video_id}
    if status == 'expired':
        if saved.get('completion_pending'):
            raise pending_result('最后一块视频已发送，但原会话已不可查询，需先确认是否上传成功。')
        print('服务器确认原上传会话已过期，自动重新创建上传会话', flush=True)
        return dict(current)
    same_content = (saved.get('sha256') == current['sha256'] if saved.get('sha256')
                    else all(saved.get(key) == current[key] for key in ('file', 'size', 'mtime')))
    if same_content:
        print('服务器确认原上传未完成，继续原会话断点续传', flush=True)
        return {**saved, **current, 'completion_pending': False}
    print('成片已变化且服务器确认原上传未完成，自动创建新会话上传当前成片', flush=True)
    return dict(current)
