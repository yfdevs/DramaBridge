import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { downloadAsset } from "../scripts/prepare-ci-ffmpeg.mjs";

async function fixture(t, handler) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ci-ffmpeg-"));
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, url: `http://127.0.0.1:${server.address().port}/asset` };
}

test("license download retries HTTP 504 without omitting license", async (t) => {
  let requests = 0;
  const { directory, url } = await fixture(t, (_, response) => {
    response.statusCode = ++requests < 3 ? 504 : 200;
    response.end(requests < 3 ? "Gateway timeout" : "upstream license");
  });
  const destination = path.join(directory, "ffmpeg.LICENSE");
  await downloadAsset(url, destination, { delay: 1 });
  assert.equal(requests, 3);
  assert.equal(await readFile(destination, "utf8"), "upstream license");
});

test("truncated binary download is retried before publishing decompressed file", async (t) => {
  let requests = 0;
  const { directory, url } = await fixture(t, (_, response) => {
    response.end(++requests === 1 ? Buffer.from("corrupt gzip") : gzipSync("complete binary"));
  });
  const destination = path.join(directory, "ffmpeg");
  await downloadAsset(url, destination, { gzip: true, delay: 1 });
  assert.equal(requests, 2);
  assert.equal(await readFile(destination, "utf8"), "complete binary");
  assert.deepEqual(await readdir(directory), ["ffmpeg"]);
});

test("persistent download failure fails the build and preserves the existing file", async (t) => {
  let requests = 0;
  const { directory, url } = await fixture(t, (_, response) => {
    requests++;
    response.statusCode = 504;
    response.end("Gateway timeout");
  });
  const destination = path.join(directory, "ffmpeg");
  await writeFile(destination, "valid cached binary");
  await assert.rejects(downloadAsset(url, destination, { delay: 1 }), /HTTP 504/);
  assert.equal(requests, 5);
  assert.equal(await readFile(destination, "utf8"), "valid cached binary");
  assert.deepEqual(await readdir(directory), ["ffmpeg"]);
});
