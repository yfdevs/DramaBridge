import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("manual desktop OAuth validates callback origin and state, and rejects replay", async () => {
  const script = `
import sys, tempfile, json
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from oauth_service import Authorization, SCOPE
saved=[]
class Credentials:
    granted_scopes=[SCOPE]
    def to_json(self):return json.dumps({'refresh_token':'test-token'})
class Flow:
    credentials=Credentials()
    def authorization_url(self,**kwargs):return ('https://accounts.google.com/o/oauth2/auth?state=test-state','test-state')
    def fetch_token(self,**kwargs):assert kwargs['code']=='test-code'
with tempfile.TemporaryDirectory() as root:
    auth=Authorization(Path(root),12345,lambda *args:None,lambda:'',flow_factory=lambda *args:Flow(),account_saver=lambda account,token:saved.append((account,token)))
    auth.start(manual=True,account_id='channel')
    for url in ['http://evil.example/api/oauth/callback?state=test-state&code=test-code','http://127.0.0.1:12345/api/oauth/callback?state=wrong&code=test-code']:
        try:auth.finish_redirect(url)
        except ValueError:pass
        else:raise AssertionError('invalid callback accepted')
    assert not saved
    url='http://127.0.0.1:12345/api/oauth/callback?state=test-state&code=test-code'
    auth.finish_redirect(url)
    assert auth.status()['status']=='succeeded'
    assert saved==[('channel',{'refresh_token':'test-token'})]
    try:auth.finish_redirect(url)
    except ValueError:pass
    else:raise AssertionError('callback replay accepted')
`;
  const result = await promisify(execFile)(process.platform === "win32" ? "python" : "python3", [
    "-B",
    "-c",
    script,
    fileURLToPath(new URL("../python/app", import.meta.url)),
  ]);
  assert.equal(result.stderr, "");
});
