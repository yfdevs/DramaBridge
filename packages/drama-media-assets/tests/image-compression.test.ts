import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { compressImageForUpload } from "../src/index.js";

test("keeps an image unchanged when it does not exceed the compression threshold", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "image-compress-pass-"));
  try {
    const inputFile = path.join(directory, "small.png");
    await sharp({ create: { width: 32, height: 32, channels: 3, background: "#ffffff" } })
      .png()
      .toFile(inputFile);
    const prepared = await compressImageForUpload({
      inputFile,
      outputDir: path.join(directory, "output"),
      outputFileName: "small.jpg",
      policy: { compressAboveBytes: 10_000, targetFileBytes: 9_000 },
    });

    assert.equal(prepared.file, inputFile);
    assert.equal(prepared.compressed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("compresses an oversized image below the configured target", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "image-compress-large-"));
  try {
    const inputFile = path.join(directory, "large.png");
    await sharp({
      create: { width: 1_200, height: 800, channels: 3, background: "#597aa3" },
    }).png({ compressionLevel: 0 }).toFile(inputFile);
    const prepared = await compressImageForUpload({
      inputFile,
      outputDir: path.join(directory, "output"),
      outputFileName: "large.png",
      policy: { compressAboveBytes: 100_000, targetFileBytes: 80_000 },
    });

    assert.equal(prepared.compressed, true);
    assert.match(prepared.file, /\.jpg$/u);
    assert.ok((await stat(prepared.file)).size <= 80_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
