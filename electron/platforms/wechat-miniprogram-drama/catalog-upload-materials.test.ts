import assert from "node:assert/strict"
import test from "node:test"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { resolveFfmpegExecutablePath, readVideoDurationSeconds } from "@dramabridge/media-assets"
import { catalogEpisodeDownloadSelection, prepareCatalogEpisodeUpload } from "./catalog-upload-materials"

test("a 61-episode catalog upload explicitly requests episodes 1–4 without full-source validation", () => {
  assert.deepEqual(catalogEpisodeDownloadSelection(61, 4), {
    episodeCount: 61, episodeDownloadNumbers: [1, 2, 3, 4],
  })
  assert.deepEqual(catalogEpisodeDownloadSelection(61, 1).episodeDownloadNumbers, [1])
  assert.deepEqual(catalogEpisodeDownloadSelection(2, 2).episodeDownloadNumbers, [1, 2])
})

for (const pcm of [false, true]) {
  test(`MOV becomes a real MP4 with preserved duration and original file (PCM audio: ${pcm})`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "catalog-mov-"))
    try {
      const source = path.join(root, "第1集.MOV")
      await promisify(execFile)(resolveFfmpegExecutablePath(), [
        "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x96:r=25",
        ...(pcm ? ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"] : []),
        "-t", "1", "-c:v", pcm ? "qtrle" : "libx264", ...(pcm ? ["-c:a", "pcm_s16le"] : []), source,
      ], { windowsHide: true })
      const original = await readFile(source)
      const logs: string[] = []
      const signal = new AbortController().signal
      const output = await prepareCatalogEpisodeUpload(source, path.join(root, "cache"), signal, message => logs.push(message))
      assert.equal(path.extname(output), ".mp4")
      assert.ok(Math.abs(await readVideoDurationSeconds(output) - 1) <= 0.2)
      assert.deepEqual(await readFile(source), original)
      const before = (await stat(output)).mtimeMs
      assert.equal(await prepareCatalogEpisodeUpload(source, path.join(root, "cache"), signal), output)
      assert.equal((await stat(output)).mtimeMs, before)
      if (pcm) assert.ok(logs.some(message => message.includes("H.264/AAC")))
      assert.equal(await prepareCatalogEpisodeUpload(output, path.join(root, "cache"), signal), output)
    } finally {
      // root comes directly from mkdtemp under the OS temporary directory.
      assert.equal(path.dirname(root), path.resolve(tmpdir()))
      await rm(root, { recursive: true, force: true })
    }
  })
}

test("an aborted upload does not start MOV conversion", async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(prepareCatalogEpisodeUpload("unused.mov", "unused", controller.signal), { name: "AbortError" })
})
