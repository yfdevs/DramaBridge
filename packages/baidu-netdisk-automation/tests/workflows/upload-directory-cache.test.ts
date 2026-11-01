import assert from "node:assert/strict";
import test from "node:test";
import { createUploadDirectoryCache } from "../../src/workflows/upload-directory-cache.js";

test("reuses directory reads, records committed files, and invalidates a renamed subtree", async () => {
  const reads: string[] = [];
  const cache = createUploadDirectoryCache(async directory => { reads.push(directory); return []; });
  await Promise.all([cache.list("/versions"), cache.list("/versions")]);
  await cache.list("/versions/old/videos");
  await cache.remember({ path: "/versions/file.mp4", server_filename: "file.mp4", size: 3, isdir: 0 });
  assert.equal((await cache.list("/versions")).length, 1);
  assert.deepEqual(reads, ["/versions", "/versions/old/videos"]);
  cache.invalidate("/versions/old");
  await cache.list("/versions");
  await cache.list("/versions/old/videos");
  assert.deepEqual(reads, ["/versions", "/versions/old/videos", "/versions", "/versions/old/videos"]);
});

test("fresh validation bypasses cache and failed reads do not poison retries", async () => {
  let reads = 0;
  const cache = createUploadDirectoryCache(async () => {
    if (++reads === 1) throw new Error("temporary failure");
    return [];
  });
  await assert.rejects(cache.list("/"), /temporary/);
  await cache.list("/");
  await cache.list("/");
  assert.equal(reads, 2);
  await cache.list("/", true);
  assert.equal(reads, 3);
});

test("concurrent file commits in one directory do not discard each other's cached entries", async () => {
  const cache = createUploadDirectoryCache(async () => []);
  await cache.list("/videos");
  await Promise.all(["1.mp4", "2.mp4", "3.mp4"].map(name => cache.remember({
    path: `/videos/${name}`, server_filename: name, size: 1, isdir: 0,
  })));
  assert.deepEqual((await cache.list("/videos")).map(file => file.server_filename).sort(), ["1.mp4", "2.mp4", "3.mp4"]);
});
