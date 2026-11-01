import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import type { DramaAiClient, ImageGenerationOptions } from "@dramabridge/ai";
import { ensureRenamedPortraitPoster } from "../src/renamed-portrait-poster.js";

test("reference-title edits are portrait, retain full content, and cache by source bytes and version name", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "renamed-poster-"));
  try {
    const referenceFile = path.join(root, "original.jpg");
    await sharp({ create: { width: 40, height: 60, channels: 3, background: "red" } })
      .jpeg()
      .toFile(referenceFile);
    const generated = await sharp({
      create: { width: 64, height: 96, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    const calls: ImageGenerationOptions[] = [];
    const client = {
      generateImage: async (input: ImageGenerationOptions) => {
        calls.push(input);
        return { images: [{ data: generated, mimeType: "image/png" }], model: "image-model" };
      },
    } as DramaAiClient;
    const options = {
      client,
      model: "image-model",
      originalTitle: "原版名称",
      title: "替换名称",
      referenceFile,
      cacheDirectory: path.join(root, "cache"),
    };
    const first = await ensureRenamedPortraitPoster(options);
    const metadata = await sharp(first.data).metadata();
    assert.deepEqual([metadata.width, metadata.height], [1080, 1920]);
    assert.match(calls[0].prompt, /原版名称/);
    assert.match(calls[0].prompt, /替换名称/);
    assert.equal(calls[0].size, "1440x2560");
    assert.match(
      (calls[0].referenceImages![0] as { dataUrl: string }).dataUrl,
      /^data:image\/png;base64,/,
    );
    assert.equal((await ensureRenamedPortraitPoster(options)).reused, true);
    assert.equal(calls.length, 1);
    assert.notEqual(
      (await ensureRenamedPortraitPoster({ ...options, title: "另一个版本" })).file,
      first.file,
    );
    await sharp({ create: { width: 40, height: 60, channels: 3, background: "green" } })
      .jpeg()
      .toFile(referenceFile);
    assert.notEqual((await ensureRenamedPortraitPoster(options)).file, first.file);
    assert.equal(calls.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("landscape, empty and copied originals cannot silently become version posters; cancellation prevents cache writes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "invalid-poster-"));
  try {
    const referenceFile = path.join(root, "original.png");
    const reference = await sharp({
      create: { width: 40, height: 60, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    await writeFile(referenceFile, reference);
    const landscape = await sharp({
      create: { width: 60, height: 40, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    for (const data of [landscape, Buffer.alloc(0), reference]) {
      let calls = 0;
      const client = {
        generateImage: async () => {
          calls++;
          return { images: [{ data, mimeType: "image/png" }], model: "test" };
        },
      } as unknown as DramaAiClient;
      await assert.rejects(
        ensureRenamedPortraitPoster({
          client,
          model: "test",
          title: "新版",
          originalTitle: "原版",
          referenceFile,
          cacheDirectory: root,
          retryAttempts: 1,
        }),
        /海报生成失败/,
      );
      assert.equal(calls, 2);
    }
    const controller = new AbortController();
    const client = {
      generateImage: async () => {
        controller.abort();
        return { images: [{ data: reference, mimeType: "image/png" }], model: "test" };
      },
    } as unknown as DramaAiClient;
    await assert.rejects(
      ensureRenamedPortraitPoster({
        client,
        model: "test",
        title: "新版",
        originalTitle: "原版",
        referenceFile,
        cacheDirectory: root,
        signal: controller.signal,
      }),
      /abort/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
