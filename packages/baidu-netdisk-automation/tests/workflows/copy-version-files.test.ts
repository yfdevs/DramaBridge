import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  assertBaiduCopyResult,
  copyBaiduVersionFiles,
  validateBaiduVersionReuse,
  type BaiduCopyItem,
} from "../../src/workflows/copy-version-files.js";
import type {
  RemoteVerificationEntry,
  RemoteVerifiedFile,
} from "../../src/workflows/upload-verification.js";

const md5 = (value: string) => createHash("md5").update(value).digest("hex");
function fixture() {
  const source = "/快手_二创集合/原剧/首版-60%",
    target = "/快手_二创集合/原剧/新版-60%";
  const local = path.resolve("local-version");
  const video = {
    path: source + "/成片/首版-第1集.mp4",
    server_filename: "首版-第1集.mp4",
    size: 10,
    isdir: 0,
    fs_id: 11,
    server_mtime: 123,
    md5: "f".repeat(32),
  };
  const cover = {
    path: source + "/封面/封面.png",
    server_filename: "封面.png",
    size: 5,
    isdir: 0,
    fs_id: 12,
    server_mtime: 123,
    md5: md5("cover"),
  };
  const cloud = new Map<string, RemoteVerificationEntry>([
    [video.path, video],
    [cover.path, cover],
  ]);
  for (const root of [source, target])
    for (const name of ["成片", "封面"])
      cloud.set(`${root}/${name}`, {
        path: `${root}/${name}`,
        server_filename: name,
        isdir: 1,
        size: 0,
      });
  const saved: RemoteVerifiedFile[] = [
    {
      path: video.path,
      fsId: "11",
      size: 10,
      serverMd5: video.md5,
      serverMtime: 123,
      contentMd5: md5("video"),
    },
  ];
  const identities = new Map([
    [
      path.join(local, "成片", "新版-第1集.mp4"),
      { size: 10, md5: md5("video"), hashes: [], modifiedAtMs: 0 },
    ],
    [
      path.join(local, "封面", "封面.png"),
      { size: 5, md5: md5("cover"), hashes: [], modifiedAtMs: 0 },
    ],
  ]);
  const copies: BaiduCopyItem[][] = [],
    receipts: RemoteVerifiedFile[] = [];
  let checks = 0;
  const options = {
    source: { remoteDirectory: source, verifiedFiles: saved },
    targetDirectory: target,
    localDirectory: local,
    identities,
    list: async (directory: string) =>
      [...cloud.values()]
        .filter((file) => path.posix.dirname(file.path) === directory)
        .map((file) => ({ ...file })),
    copy: async (items: BaiduCopyItem[]): Promise<Record<string, unknown>> => {
      copies.push(items);
      for (const item of items) {
        const original = cloud.get(item.path)!;
        const destination = path.posix.join(item.dest, item.newname);
        assert.ok(!cloud.has(destination), "never overwrite an existing target");
        cloud.set(destination, {
          ...original,
          path: destination,
          server_filename: item.newname,
          fs_id: 100 + copies.length * 10 + items.indexOf(item),
          server_mtime: 200,
        });
      }
      return { errno: 0 };
    },
    query: async (_taskId: string): Promise<Record<string, unknown>> => ({
      errno: 0,
      status: "success",
      list: [{ error_code: 0 }],
    }),
    verify: async (_file: RemoteVerificationEntry, _identity: { md5: string }) => {
      checks++;
      return true;
    },
    wait: async (_milliseconds: number) => undefined,
    onVerified: (file: RemoteVerifiedFile) => {
      receipts.push(file);
    },
  };
  return { options, cloud, video, copies, receipts, saved, target, source, checks: () => checks };
}

test("same contents are copied in one batch into the new names without re-upload or content readback", async () => {
  const f = fixture();
  const receipts = await copyBaiduVersionFiles(f.options);
  assert.equal(f.copies.length, 1);
  assert.equal(f.copies[0].length, 2);
  assert.deepEqual(f.copies[0][0], {
    path: f.video.path,
    dest: f.target + "/成片",
    newname: "新版-第1集.mp4",
  });
  assert.equal(f.cloud.get(f.video.path)?.fs_id, 11, "source remains intact");
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].contentMd5, md5("video"));
  assert.equal(f.checks(), 0);
});

test("different bytes or stale source receipts are excluded so only the remaining files need upload", async () => {
  for (const stale of [false, true]) {
    const f = fixture();
    if (stale) f.saved[0].serverMtime = 999;
    else
      f.options.identities.get(path.join(f.options.localDirectory, "成片", "新版-第1集.mp4"))!.md5 =
        md5("different video");
    await copyBaiduVersionFiles(f.options);
    assert.equal(f.copies[0].length, 1);
    assert.equal(f.copies[0][0].newname, "封面.png");
    assert.equal(f.cloud.has(f.target + "/成片/新版-第1集.mp4"), false);
  }
});

test("async copies require terminal success and reject per-item failures before sharing", async () => {
  const f = fixture();
  const copy = f.options.copy;
  f.options.copy = async (items) => {
    await copy(items);
    return { errno: 0, taskid: 123 };
  };
  let queries = 0;
  f.options.query = async (id) => {
    assert.equal(id, "123");
    return { errno: 0, status: ++queries === 1 ? "running" : "success", list: [{ error_code: 0 }] };
  };
  await copyBaiduVersionFiles(f.options);
  assert.equal(queries, 2);
  const broken = fixture();
  broken.options.copy = async () => ({ errno: 0, taskid: "failed-task" });
  broken.options.query = async () => ({ errno: 0, status: "success", list: [{ error_code: -30 }] });
  await assert.rejects(copyBaiduVersionFiles(broken.options), /errno=-30/);
  const rejected = fixture(),
    rejectedCopy = rejected.options.copy;
  rejected.options.copy = async (items) => {
    await rejectedCopy(items);
    return { errno: 0, taskid: "rejected-task", task_errno: 12 };
  };
  await assert.rejects(copyBaiduVersionFiles(rejected.options), /errno=12/);
  assert.throws(() => assertBaiduCopyResult({ errno: 0, info: [{ errno: 12 }] }), /errno=12/);
  assert.throws(() => assertBaiduCopyResult({ errno: 0, task_errno: 12 }), /errno=12/);
  assert.throws(
    () => assertBaiduCopyResult({ errno: 0, list: [{ errno: 0, error_code: -30 }] }),
    /errno=-30/,
  );
  assert.throws(
    () => assertBaiduCopyResult({ errno: 0, task_errno: 8001 }),
    /BAIDU_NETDISK_RISK_CONTROL/,
  );
  assert.throws(
    () => assertBaiduCopyResult({ errno: 0, list: [{ error_code: 132 }] }),
    /BAIDU_NETDISK_IDENTITY_VERIFICATION/,
  );
  assert.throws(() => assertBaiduCopyResult({ errno: 0, status: "failed" }), /status=failed/);
});

test("large versions use bounded batches and cancellation stops before another write", async () => {
  const f = fixture();
  for (let i = 2; i <= 105; i++)
    f.options.identities.set(path.join(f.options.localDirectory, "成片", `新版-第${i}集.mp4`), {
      size: 10,
      md5: md5("video"),
      hashes: [],
      modifiedAtMs: 0,
    });
  await copyBaiduVersionFiles(f.options);
  assert.deepEqual(
    f.copies.map((batch) => batch.length),
    [50, 50, 6],
  );
  const cancelled = fixture(),
    controller = new AbortController(),
    copy = cancelled.options.copy;
  cancelled.options.copy = async (items) => {
    const result = await copy(items);
    controller.abort();
    return result;
  };
  await assert.rejects(
    copyBaiduVersionFiles({ ...cancelled.options, signal: controller.signal }),
    /abort/i,
  );
  assert.equal(cancelled.copies.length, 1);
});

test("a lost copy response is reconciled without repeating its write", async () => {
  const f = fixture(),
    copy = f.options.copy;
  f.options.copy = async (items) => {
    await copy(items);
    throw new Error("HTTP 503 after commit");
  };
  await copyBaiduVersionFiles(f.options);
  assert.equal(f.copies.length, 1);
  assert.equal(f.receipts.length, 2);
  await copyBaiduVersionFiles(f.options);
  assert.equal(f.copies.length, 1, "already-present verified targets are reused on resume");
});

test("risk responses stop immediately, uncertain absent results stay pending, and cross-drama sources are rejected", async () => {
  const risk = fixture();
  risk.options.copy = async () => {
    throw new Error("[BAIDU_NETDISK_RISK_CONTROL] errno=8001");
  };
  await assert.rejects(copyBaiduVersionFiles(risk.options), /BAIDU_NETDISK_RISK_CONTROL/);
  const uncertain = fixture();
  let writes = 0;
  uncertain.options.copy = async () => {
    writes++;
    throw new Error("connection lost");
  };
  await assert.rejects(copyBaiduVersionFiles(uncertain.options), /云端复制结果尚未确认/);
  assert.equal(writes, 1);
  assert.throws(
    () => validateBaiduVersionReuse("/快手_二创集合/其他剧/首版-60%", uncertain.target),
    /同一剧目/,
  );
  assert.throws(() => validateBaiduVersionReuse(uncertain.target, uncertain.target), /其他版本/);
});

test("changed copy metadata cannot inherit a source receipt and must pass content verification", async () => {
  const f = fixture(),
    copy = f.options.copy;
  f.options.copy = async (items) => {
    const result = await copy(items);
    f.cloud.get(f.video.path)!.server_mtime = 999;
    return result;
  };
  f.options.verify = async () => {
    throw new Error("actual target bytes are wrong");
  };
  await assert.rejects(copyBaiduVersionFiles(f.options), /actual target bytes are wrong/);
  assert.equal(f.receipts.length, 0);
});
