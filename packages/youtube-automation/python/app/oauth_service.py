"""Short-lived Google desktop OAuth sessions; credentials stay on the server."""
import hmac
import json
import os
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from project_paths import credential_path

SCOPE = 'https://www.googleapis.com/auth/youtube.upload'
UPLOAD_SCOPES = {SCOPE, 'https://www.googleapis.com/auth/youtube',
                 'https://www.googleapis.com/auth/youtube.force-ssl',
                 'https://www.googleapis.com/auth/youtubepartner'}


def save_token(path, content):
    """Atomically save a token returned by the Google OAuth callback."""
    if not isinstance(content, dict):
        raise ValueError("授权信息格式无效")
    for key in ("client_id", "client_secret", "refresh_token"):
        if not isinstance(content.get(key), str) or not content[key].strip():
            raise ValueError("授权信息缺少必要字段")
    if content.get("token_uri", "https://oauth2.googleapis.com/token") not in {"https://oauth2.googleapis.com/token", "https://accounts.google.com/o/oauth2/token"}:
        raise ValueError("仅支持 Google OAuth 授权信息")
    if "expiry" in content and not isinstance(content["expiry"], str):
        raise ValueError("授权信息的有效期格式无效")
    if "token" in content and content["token"] is not None and not isinstance(content["token"], str):
        raise ValueError("访问令牌格式无效")
    from google.oauth2.credentials import Credentials
    try:
        Credentials.from_authorized_user_info(content, ["https://www.googleapis.com/auth/youtube.upload"])
    except (ValueError, TypeError, AttributeError):
        raise ValueError("授权信息格式无效") from None
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".oauth-", suffix=".tmp", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(content, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)


def test_authorization(path, proxy):
    """Check refreshability and live upload scopes without changing saved credentials."""
    import requests

    def result(status, message):
        return {'status': status, 'message': message}

    try:
        content = Path(path).read_text(encoding='utf-8-sig')
        token = json.loads(content)
        if (not isinstance(token, dict) or
                any(not isinstance(token.get(key), str) or not token[key].strip()
                    for key in ('client_id', 'client_secret', 'refresh_token')) or
                token.get('token_uri', 'https://oauth2.googleapis.com/token') not in
                {'https://oauth2.googleapis.com/token', 'https://accounts.google.com/o/oauth2/token'}):
            raise ValueError('invalid credentials')
    except FileNotFoundError:
        return result('invalid', '尚未保存授权，请先点击“更新授权信息”完成授权')
    except (ValueError, TypeError):
        return result('invalid', '授权文件格式无效，请重新更新授权信息')
    except OSError:
        return result('error', '无法读取授权文件，请检查服务器文件权限后重试')

    try:
        with requests.Session() as session:
            session.trust_env = False
            session.proxies = {'http': proxy, 'https': proxy} if proxy else {}
            response = session.post('https://oauth2.googleapis.com/token', data={
                'grant_type': 'refresh_token', 'refresh_token': token['refresh_token'],
                'client_id': token['client_id'], 'client_secret': token['client_secret'],
            }, timeout=(5, 10), allow_redirects=False)
            if response.status_code in {400, 401}:
                error = response.json()
                if isinstance(error, dict) and error.get('error') == 'invalid_grant':
                    return result('invalid', '账号授权已失效（invalid_grant），请到账号管理更新授权')
                if isinstance(error, dict) and error.get('error') in {'invalid_client', 'unauthorized_client'}:
                    return result('invalid', f"Google 客户端凭据被拒绝（{error['error']}），请检查客户端凭据后重新授权")
            if response.status_code != 200:
                return result('error', 'Google 令牌服务暂时不可用，请检查代理或稍后重试')
            refreshed = response.json()
            if not isinstance(refreshed, dict) or not isinstance(refreshed.get('access_token'), str) or not refreshed['access_token']:
                return result('error', 'Google 返回了无效的令牌响应，请稍后重试')
            response = session.post('https://oauth2.googleapis.com/tokeninfo',
                                    data={'access_token': refreshed['access_token']},
                                    timeout=(5, 10), allow_redirects=False)
            if response.status_code in {400, 401}:
                return result('invalid', 'Google 未接受当前令牌，请重新更新授权信息')
            if response.status_code != 200:
                return result('error', 'Google 授权校验服务暂时不可用，请稍后重试')
            info = response.json()
            if not isinstance(info, dict) or not isinstance(info.get('scope'), str):
                return result('error', 'Google 返回了无效的校验响应，请稍后重试')
            if info.get('aud') != token['client_id'] or int(info.get('expires_in', 0)) <= 0:
                return result('invalid', '令牌已过期或客户端不匹配，请重新更新授权信息')
            if not UPLOAD_SCOPES.intersection(info['scope'].split()):
                return result('invalid', '当前授权缺少 YouTube 上传权限，请更新授权信息并允许上传权限')
        if Path(path).read_text(encoding='utf-8-sig') != content:
            return result('error', '测试期间授权文件已变化，请重新测试')
        return result('valid', '授权有效：令牌可刷新，且具有 YouTube 上传权限。实际上传仍受频道状态和配额限制')
    except requests.RequestException:
        return result('error', '无法连接 Google，请检查服务器网络和已保存的 YouTube 代理设置后重试')
    except (ValueError, TypeError, OSError):
        return result('error', '未能完成授权校验，请稍后重试；原授权文件保留')


def make_flow(path, redirect_uri):
    from google_auth_oauthlib.flow import Flow
    config = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    client = config.get('installed', {})
    if (not client.get('client_id') or not client.get('client_secret')
            or client.get('auth_uri') != 'https://accounts.google.com/o/oauth2/auth'
            or client.get('token_uri') not in {'https://oauth2.googleapis.com/token', 'https://accounts.google.com/o/oauth2/token'}):
        raise ValueError('请先上传 Google 桌面应用客户端凭据 client_secret.json')
    return Flow.from_client_config(config, scopes=[SCOPE], redirect_uri=redirect_uri,
                                   autogenerate_code_verifier=True)


class Authorization:
    def __init__(self, root, port, saver, proxy, flow_factory=make_flow, clock=time.monotonic, account_saver=None):
        self.root, self.port, self.saver, self.proxy = Path(root), port, saver, proxy
        self.flow_factory, self.clock = flow_factory, clock
        self.account_saver = account_saver
        self.account_id = 'default'
        self.lock = threading.RLock()
        self.session = None
        self.result = {'status': 'idle', 'message': ''}

    def _expire(self):
        if self.session and self.clock() >= self.session['expires']:
            self.session = None
            self.result = {'status': 'error', 'message': '授权已超时，请重新点击更新授权'}

    def pending(self):
        with self.lock:
            self._expire()
            return self.session is not None

    def status(self):
        with self.lock:
            self._expire()
            return {**self.result, 'accountId': self.account_id}

    def start(self, manual=False, account_id='default'):
        with self.lock:
            self._expire()
            if self.session:
                raise ValueError('已有授权正在进行，请完成或取消后重试')
            if account_id != 'default' and self.account_saver is None:
                raise ValueError('此服务尚未启用多账号授权，请重启服务')
            redirect_uri = f'http://127.0.0.1:{self.port}/api/oauth/callback'
            try:
                flow = self.flow_factory(credential_path(self.root, 'client_secret.json'),
                                         redirect_uri)
            except (OSError, ValueError, TypeError):
                raise ValueError('请先上传有效的 Google 桌面应用客户端凭据 client_secret.json') from None
            url, state = flow.authorization_url(access_type='offline', prompt='select_account consent', include_granted_scopes='true')
            self.session = {'flow': flow, 'state': state, 'redirect_uri': redirect_uri,
                            'expires': self.clock() + 600, 'account_id': account_id}
            self.account_id = account_id
            message = ('请在新页面完成 Google 授权，再复制最后跳转的完整地址到下方提交'
                       if manual else '请在新页面完成 Google 授权，成功后自动保存')
            self.result = {'status': 'pending', 'message': message}
            return url

    def cancel(self):
        with self.lock:
            self.session = None
            self.result = {'status': 'cancelled', 'message': '已取消授权，原授权文件保留'}

    def finish_redirect(self, callback_url):
        """Parse a pasted loopback response locally; never request the supplied URL."""
        if not isinstance(callback_url, str) or not 0 < len(callback_url) <= 8192:
            raise ValueError('请粘贴授权后地址栏中的完整回调地址')
        callback_url = callback_url.strip()
        if not callback_url or any(character.isspace() or ord(character) < 32 for character in callback_url):
            raise ValueError('回调地址格式无效，请重新复制完整地址')
        with self.lock:
            self._expire()
            if not self.session:
                raise ValueError('授权会话无效或已过期，请重新发起授权')
            expected = urlsplit(self.session['redirect_uri'])
            try:
                actual = urlsplit(callback_url)
                if ((actual.scheme, actual.netloc, actual.path) !=
                        (expected.scheme, expected.netloc, expected.path) or actual.fragment):
                    raise ValueError('unexpected redirect')
                values = parse_qs(actual.query, keep_blank_values=True, max_num_fields=30)
                state, code, error = (values.get(key, []) for key in ('state', 'code', 'error'))
                if (len(state) != 1 or not state[0] or
                        not ((len(code) == 1 and code[0] and not error) or
                             (len(error) == 1 and error[0] and not code))):
                    raise ValueError('invalid response')
            except ValueError:
                raise ValueError('请粘贴本次 Google 授权后以 ' + self.session['redirect_uri'] +
                                 '? 开头的完整地址，需包含 state 和 code（或 error）') from None
        self.finish(state[0], code[0] if code else None, error[0] if error else None)

    def finish(self, state, code=None, error=None):
        with self.lock:
            self._expire()
            session = self.session
            if (not session or not isinstance(state, str) or not state or
                    not hmac.compare_digest(session['state'].encode('utf-8'), state.encode('utf-8'))):
                raise ValueError('授权会话无效或已过期，请重新发起授权')
            if self.result['status'] != 'pending':
                raise ValueError('授权回调已处理，请勿重复提交')
            if error or not code:
                self.session = None
                self.result = {'status': 'error', 'message': '未完成 Google 授权，原授权文件保留'}
                raise ValueError(self.result['message'])
            self.result = {'status': 'exchanging', 'message': '正在保存授权信息'}
        try:
            proxy = self.proxy()
            session['flow'].fetch_token(code=code, timeout=30,
                                        proxies={'http': proxy, 'https': proxy} if proxy else {'http': None, 'https': None})
            content = json.loads(session['flow'].credentials.to_json())
            granted = session['flow'].credentials.granted_scopes
            if granted is not None and SCOPE not in granted and 'https://www.googleapis.com/auth/youtube' not in granted:
                raise ValueError('missing upload scope')
            with self.lock:
                self._expire()
                if self.session is not session:
                    raise ValueError('expired session')
                if self.account_saver:
                    self.account_saver(session['account_id'], content)
                else:
                    self.saver('token', content)
                self.session = None
                self.result = {'status': 'succeeded', 'message': '授权信息已更新'}
        except Exception:
            with self.lock:
                if self.session is session:
                    self.session = None
                    self.result = {'status': 'error', 'message': '授权保存失败，请检查代理后重试；原授权文件保留'}
            raise ValueError('授权未更新，请回到服务设置查看状态并重试') from None
