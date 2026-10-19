import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cleanupStaleRuntimeArtifacts,
  createRuntimeArtifactLease,
  materialUploadDirectoryPattern,
  runtimeArtifactLeaseFileName,
} from "../src/runtime-artifacts.js";
import { cleanupEpisodeUploadFiles, prepareEpisodeUploadFiles } from "../src/index.js";

const hourMs = 60 * 60 * 1000;

test("recognizes legacy and task-scoped material upload directories", () => {
  assert.equal(materialUploadDirectoryPattern.test("material-upload"), true);
  assert.equal(materialUploadDirectoryPattern.test("material-upload-task-67-1234-test"), true);
  assert.equal(materialUploadDirectoryPattern.test("poster-upload"), false);
});

async function temporaryRoot() {
  return mkdtemp(path.join(tmpdir(), "drama-runtime-assets-"));
}

async function makeOld(targetPath: string, ageMs = 4 * hourMs) {
  const date = new Date(Date.now() - ageMs);
  await utimes(targetPath, date, date);
}

test("removes a stale legacy upload directory nested below an account", async () => {
  const rootPath = await temporaryRoot();
  try {
    const uploadDir = path.join(rootPath, "account-a", "episode-upload-100");
    await mkdir(uploadDir, { recursive: true });
    const videoPath = path.join(uploadDir, "episode-1.mp4");
    await writeFile(videoPath, Buffer.alloc(128));
    await makeOld(videoPath);
    await makeOld(uploadDir);

    const result = await cleanupStaleRuntimeArtifacts({
      rootPath,
      maxDepth: 2,
      minimumAgeMs: 3 * hourMs,
    });

    assert.equal(result.deletedDirectoryCount, 1);
    assert.equal(result.reclaimedLogicalBytes, 128);
    await assert.rejects(stat(uploadDir), { code: "ENOENT" });
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("removes a stale task-scoped material upload directory", async () => {
  const rootPath = await temporaryRoot();
  try {
    const uploadDir = path.join(rootPath, "account-a", "material-upload-task-67-1234-test");
    await mkdir(uploadDir, { recursive: true });
    const imagePath = path.join(uploadDir, "commitment.jpg");
    await writeFile(imagePath, Buffer.alloc(64));
    await makeOld(imagePath);
    await makeOld(uploadDir);

    const result = await cleanupStaleRuntimeArtifacts({
      rootPath,
      maxDepth: 2,
      minimumAgeMs: 3 * hourMs,
    });

    assert.equal(result.deletedDirectoryCount, 1);
    await assert.rejects(stat(uploadDir), { code: "ENOENT" });
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("keeps a task-scoped material directory leased by the current process", async () => {
  const rootPath = await temporaryRoot();
  try {
    const uploadDir = path.join(rootPath, "material-upload-task-68-1234-test");
    await mkdir(uploadDir);
    await createRuntimeArtifactLease(uploadDir, "material-upload");

    const result = await cleanupStaleRuntimeArtifacts({ rootPath, minimumAgeMs: 0 });

    assert.equal(result.activeCount, 1);
    assert.equal(result.deletedDirectoryCount, 0);
    assert.equal((await stat(uploadDir)).isDirectory(), true);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("keeps an upload directory leased by the current process", async () => {
  const rootPath = await temporaryRoot();
  try {
    const uploadDir = path.join(rootPath, "episode-upload-101");
    await mkdir(uploadDir);
    await createRuntimeArtifactLease(uploadDir);

    const result = await cleanupStaleRuntimeArtifacts({
      rootPath,
      minimumAgeMs: 0,
    });

    assert.equal(result.activeCount, 1);
    assert.equal(result.deletedDirectoryCount, 0);
    assert.equal((await stat(uploadDir)).isDirectory(), true);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("keeps a young legacy upload directory", async () => {
  const rootPath = await temporaryRoot();
  try {
    const uploadDir = path.join(rootPath, "episode-upload-102");
    await mkdir(uploadDir);

    const result = await cleanupStaleRuntimeArtifacts({
      rootPath,
      minimumAgeMs: hourMs,
    });

    assert.equal(result.youngCount, 1);
    assert.equal(result.deletedDirectoryCount, 0);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("preparation writes a lease and normal cleanup removes the upload directory", async () => {
  const rootPath = await temporaryRoot();
  try {
    const sourcePath = path.join(rootPath, "source.mp4");
    const uploadRootDir = path.join(rootPath, "assets");
    await writeFile(sourcePath, Buffer.alloc(64));
    const prepared = await prepareEpisodeUploadFiles({
      localEpisodeVideoRoot: rootPath,
      resourceName: "测试剧",
      uploadRootDir,
      episodes: [{ index: 1, title: "第1集", file: sourcePath }],
    });

    assert.equal((await stat(path.join(prepared.uploadDir, runtimeArtifactLeaseFileName))).isFile(), true);
    assert.equal(prepared.files.length, 1);
    await cleanupEpisodeUploadFiles(prepared);
    await assert.rejects(stat(prepared.uploadDir), { code: "ENOENT" });
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("preparation failure removes partially created hard links and lease", async () => {
  const rootPath = await temporaryRoot();
  try {
    const sourcePath = path.join(rootPath, "source.mp4");
    const uploadRootDir = path.join(rootPath, "assets");
    await writeFile(sourcePath, Buffer.alloc(64));

    await assert.rejects(
      prepareEpisodeUploadFiles({
        localEpisodeVideoRoot: rootPath,
        resourceName: "测试剧",
        uploadRootDir,
        episodes: [
          { index: 1, title: "第1集", file: sourcePath },
          { index: 2, title: "第2集", file: path.join(rootPath, "missing.mp4") },
        ],
      }),
    );

    const entries = await readdir(uploadRootDir);
    assert.deepEqual(entries, []);
  } finally {
    await rm(rootPath, { recursive: true, force: true });
  }
});

test("refuses to use the filesystem root as a cleanup root", async () => {
  await assert.rejects(
    cleanupStaleRuntimeArtifacts({
      rootPath: path.parse(process.cwd()).root,
      minimumAgeMs: 0,
    }),
    /Refusing to use a filesystem root/,
  );
});
