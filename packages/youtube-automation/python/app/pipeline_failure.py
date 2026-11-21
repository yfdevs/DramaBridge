"""Actionable pipeline failures shared by the CLI and queue worker."""
import json
import re

PREFIX = 'DRAMAVOX_FAILURE '


def safe_detail(value):
    text = str(value)
    text = re.sub(r'(?i)(Bearer\s+)\S+', r'\1[已隐藏]', text)
    text = re.sub(r'''(?i)(["']?(?:access_token|refresh_token|client_secret|authorization|password|token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}\]]+)''',
                  r'\1[已隐藏]', text)
    text = re.sub(r'(https?://[^\s?]+)\?[^\s]+', r'\1?[已隐藏]', text)
    return text[-2000:].strip()


def describe_failure(message, stage=None, exit_code=None):
    text = str(message)
    lower = text.lower()
    rules = [
        ('UPLOAD_DAILY_QUOTA_EXCEEDED', ('video uploads per day',),
         'YouTube 今日上传额度已用完',
         '当前 Google API 项目的每日视频上传额度已耗尽。使用同一项目的多个频道共用这份额度。',
         '请暂停重试，等每日额度恢复后继续。额度按美国太平洋时间午夜重置（北京时间夏令时15:00、冬令时16:00）。可在 Google Cloud 控制台查看 Video Uploads per day 配额；长期不足时申请提高配额。重新登录或换用同一项目下的频道无法恢复额度。'),
        ('NETDISK_PAGE_UNCONFIRMED', ('尚未确认链接失效', '提取接口尚未确认', '没有进入分享文件列表'),
         '百度网盘分享页尚未就绪', '客户端未能完成分享页加载或提取，当前结果不能证明分享已过期。', '检查百度网盘客户端连接和登录状态后重试。'),
        ('NETDISK_SHARE_UNAVAILABLE', ('分享链接不可用：',),
         '百度网盘分享页报告不可用', '重新加载后的分享页仍显示访问错误。', '在百度网盘客户端打开原链接，核对提取码和分享状态后重试。'),
        ('NETDISK_LOGIN_REQUIRED', ('百度网盘账号登录已过期', '百度网盘客户端重新登录'),
         '百度网盘需要重新登录', '客户端当前登录状态不可用。', '在百度网盘客户端重新登录后重试下载。'),
        ('NETDISK_CONNECTION_ERROR', ('百度网盘 cdp', '百度网盘调试端口', 'baidu_cdp_'),
         '百度网盘客户端连接失败', '无法连接客户端或客户端自动化组件尚未就绪。', '在百度网盘连接管理中重新连接客户端后重试。'),
        ('AUTH_CLIENT_INVALID', ('invalid_client', 'unauthorized_client', '客户端凭据被拒绝'),
         'Google 客户端凭据无效', 'Google 拒绝了当前客户端凭据。', '检查配置中的 Google 客户端凭据，再到账号管理更新授权。'),
        ('AUTH_INVALID', ('invalid_grant', 'token 已失效', '授权缺失或已失效', '授权已失效', '尚未保存授权', '授权文件格式无效', 'google 未接受当前令牌', '令牌已过期或客户端不匹配'),
         '账号授权已失效', '当前账号授权无法刷新，或授权文件缺失、无效。', '到账号管理更新该账号的授权，测试通过后重试。'),
        ('QUOTA_EXCEEDED', ('quotaexceeded', 'dailylimitexceeded', 'uploadlimitexceeded', '配额已用完'),
         'YouTube 上传额度不足', 'Google 拒绝了本次上传，当前项目或频道已达到限额。', '检查 YouTube API 配额及频道上传限制，额度恢复后再重试。'),
        ('PERMISSION_DENIED', ('insufficientpermissions', 'insufficient authentication scopes', '缺少 youtube 上传权限', 'accessnotconfigured'),
         'YouTube 上传权限不足', '当前授权没有上传权限，或项目未启用 YouTube API。', '检查项目是否启用 YouTube Data API，并重新授权上传权限。'),
        ('DISK_FULL', ('no space left', 'disk full', '磁盘空间不足', 'not enough space'),
         '磁盘空间不足', '无法继续保存处理文件。', '释放运行数据目录所在磁盘的空间后重试。'),
        ('OUT_OF_MEMORY', ('out of memory', 'memoryerror', 'bad_alloc', '内存不足'),
         '可用内存不足', '视频处理无法分配足够的内存。', '关闭占用内存较多的程序，减少同时运行的任务后重试。'),
        ('NETWORK_ERROR', ('connectionerror', 'connection reset', 'proxyerror', 'timed out', 'timeout', 'sslerror', '网络连接错误', '无法连接 google', '令牌服务暂时不可用', '授权校验服务暂时不可用'),
         '无法连接 Google', 'Google 连接失败或响应超时，当前结果不能证明授权已失效。', '检查网络和 YouTube 代理设置，连接恢复后重试。'),
        ('DEPENDENCY_MISSING', ('no module named', 'modulenotfounderror', '未找到 ffmpeg', '未找到 ffprobe'),
         '处理环境缺少依赖', '所需的 Python 模块或媒体工具不可用。', '到配置管理检查并准备运行环境，完成后重试。'),
        ('MEDIA_INVALID', ('invalid data found', '解码校验失败', '拼接或成片校验失败', '视频缺少画面或音轨', '无法读取该格式'),
         '视频素材或成片校验失败', '素材无法正常解码，或生成的视频未通过校验。', '检查失败视频是否完整、可播放，修复或重新下载后重试。'),
        ('UPLOAD_SESSION_INVALID', ('上传会话已失效', '无法安全恢复上传', '上传会话无法恢复'),
         '上传会话无法恢复', '原上传会话已失效、未完整保存，或待上传文件已变化，无法安全续传。', '先到该账号的 YouTube Studio 核对视频是否已上传，再处理原上传会话，避免重复上传。'),
    ]
    for code, needles, title, reason, action in rules:
        if any(needle.lower() in lower for needle in needles):
            break
    else:
        code = 'PROCESS_FAILED'
        title = {'authorizing': '账号连接失败', 'uploading': '视频上传失败', 'thumbnail': '封面设置失败',
                 'separating': '人声分离失败', 'loading_model': '模型加载失败', 'merging': '视频合并失败',
                 'validating': '视频校验失败', 'remuxing': '视频合成失败'}.get(stage, '处理程序异常退出')
        reason = '处理程序未正常完成，暂时无法确定具体原因。'
        action = '根据错误详情检查运行环境；若仍失败，请提供任务编号和错误详情。'
    if code == 'AUTH_INVALID' and 'invalid_grant' in lower:
        reason = 'Google 已拒绝刷新该账号的授权，授权可能已过期或被撤销。'
    result = dict(code=code, title=title, reason=reason, action=action, detail=safe_detail(text))
    if stage:
        result['stage'] = stage
    if exit_code is not None:
        result['exitCode'] = exit_code
    return result


class PipelineFailure(RuntimeError):
    def __init__(self, failure):
        self.failure = failure
        super().__init__(failure['title'])


def parse_failure(line):
    if not line.startswith(PREFIX):
        return None
    try:
        value = json.loads(line[len(PREFIX):])
        if not isinstance(value, dict) or any(not isinstance(value.get(k), str) or not value[k]
                                              for k in ('code', 'title', 'reason', 'action')):
            return None
        return {k: safe_detail(value[k]) for k in ('code', 'title', 'reason', 'action', 'detail') if k in value}
    except (ValueError, TypeError):
        return None


def emit_failure(error):
    failure = error.failure if isinstance(error, PipelineFailure) else describe_failure(error)
    print(PREFIX + json.dumps(failure, ensure_ascii=False), flush=True)
