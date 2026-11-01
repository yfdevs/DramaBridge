import assert from "node:assert/strict";
import test from "node:test";
import { baiduUploadServers, isBaiduUploadTransportError } from "../../src/workflows/upload-servers.js";

test("uses discovered upload nodes with client defaults and rejects unsafe cookie destinations", () => {
  assert.deepEqual(baiduUploadServers({ server: [
    { server: "c3.pcs.baidu.com" }, "https://c3.pcs.baidu.com", "https://baidu.com.attacker.test",
    "https://pcs.baidu.com@attacker.test", "http://c4.pcs.baidu.com", "https://c4.pcs.baidu.com:8443",
    "https://c4.pcs.baidu.com/upload", "https://c4.pcs.baidu.com?cookie=true",
  ] }), ["https://c3.pcs.baidu.com", "https://c2.pcs.baidu.com", "https://d.pcs.baidu.com"]);
  assert.deepEqual(baiduUploadServers(undefined), ["https://c2.pcs.baidu.com", "https://d.pcs.baidu.com"]);
});

test("only transport errors permit retrying the same block on a backup host", () => {
  assert.equal(isBaiduUploadTransportError(new Error("net::ERR_CONNECTION_CLOSED")), true);
  assert.equal(isBaiduUploadTransportError(new Error("上传 HTTP 503")), true);
  assert.equal(isBaiduUploadTransportError(new Error("errno=8001")), false);
  assert.equal(isBaiduUploadTransportError(new Error("HTTP 403")), false);
});
