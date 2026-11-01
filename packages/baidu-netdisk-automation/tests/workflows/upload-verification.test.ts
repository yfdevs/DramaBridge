import assert from "node:assert/strict";
import test from "node:test";
import { createRemoteFileVerifier, type RemoteVerifiedFile } from "../../src/workflows/upload-verification.js";

test("multipart server checksum mismatch is resolved by actual content, and persisted receipts avoid rereading", async () => {
  const file = { path: "/快手_二创集合/本剧/汇总/成片/第10集.mp4", server_filename: "第10集.mp4", isdir: 0,
    size: 53261063, md5: "fa8a227f41610954ec6ddfd72f10f1cb", fs_id: "123", server_mtime: 100 };
  const identity = { size: file.size, md5: "23fa2fec3b0267a7a3bd2c5be8a07560", hashes: [], modifiedAtMs: 0 };
  const saved: RemoteVerifiedFile[] = [];
  let reads = 0;
  const metadata = async () => ({ ...file, dlink: "https://d.pcs.baidu.com/content" });
  const verify = createRemoteFileVerifier({ metadata, onVerified: receipt => saved.push(receipt),
    contentChecksum: async () => { reads++; return { size: file.size, md5: identity.md5 }; } });
  assert.equal(await verify(file, identity), true);
  assert.equal(await verify(file, identity), true);
  assert.equal(reads, 1);
  const reopened = createRemoteFileVerifier({ saved: JSON.parse(JSON.stringify(saved)), metadata,
    contentChecksum: async () => { reads++; return { size: file.size, md5: "wrong" }; } });
  assert.equal(await reopened(file, identity), true);
  assert.equal(reads, 1);
  assert.equal(await reopened({ ...file, server_mtime: 101 }, identity), false);
  assert.equal(reads, 2);
});

test("size mismatch and truly different bytes cannot pass verification", async () => {
  const file = { path: "/快手_二创集合/本剧/成片/第1集.mp4", server_filename: "第1集.mp4", isdir: 0,
    size: 100, md5: "0".repeat(32), fs_id: "1", server_mtime: 100 };
  const identity = { size: 100, md5: "1".repeat(32), hashes: [], modifiedAtMs: 0 };
  const verify = createRemoteFileVerifier({ metadata: async () => ({ ...file, dlink: "https://d.pcs.baidu.com/content" }),
    contentChecksum: async () => ({ size: 100, md5: "2".repeat(32) }) });
  assert.equal(await verify({ ...file, size: 99 }, identity), false);
  assert.equal(await verify(file, identity), false);
});

test("file pipeline cancellation reaches metadata and content verification without persisting a receipt", async () => {
  const controller = new AbortController();
  const file = { path: "/videos/1.mp4", server_filename: "1.mp4", isdir: 0, size: 10, md5: "0".repeat(32) };
  const identity = { size: 10, md5: "1".repeat(32), hashes: [], modifiedAtMs: 0 };
  let receipts = 0, reading = false;
  const verify = createRemoteFileVerifier({
    metadata: async (_path, signal) => { assert.equal(signal, controller.signal); return { ...file, dlink: "https://d.pcs.baidu.com/content" }; },
    contentChecksum: async (_url, _size, _path, signal) => {
      assert.equal(signal, controller.signal);
      reading = true;
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    },
    onVerified: () => { receipts++; },
  });
  const pending = verify(file, identity, controller.signal);
  const rejection = assert.rejects(pending, /另一个文件失败/);
  while (!reading) await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error("另一个文件失败"));
  await rejection;
  assert.equal(receipts, 0);
});
