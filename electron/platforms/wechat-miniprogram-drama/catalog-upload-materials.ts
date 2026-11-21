import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, rename, rm, stat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

export function catalogEpisodeDownloadSelection(episodeCount: number, downloadCount: number) {
  return {
    episodeCount,
    episodeDownloadNumbers: Array.from({ length: downloadCount }, (_, index) => index + 1),
  }
}

export async function prepareCatalogEpisodeUpload(file: string, cacheRoot: string, signal: AbortSignal, onLog: (message: string) => void = () => {}) {
  signal.throwIfAborted()
  if (path.extname(file).toLowerCase() !== ".mov") return file
  const { resolveFfmpegExecutablePath, readVideoDurationSeconds } = await import("@dramabridge/media-assets")
  const info = await stat(file)
  const key = createHash("sha256").update(JSON.stringify([path.resolve(file), info.size, info.mtimeMs, "catalog-mp4-v1"])).digest("hex").slice(0, 24)
  const directory = path.join(cacheRoot, key)
  await mkdir(directory, { recursive: true })
  const output = path.join(directory, `${path.parse(file).name}.mp4`)
  const duration = await readVideoDurationSeconds(file)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`MOV 视频时长无效：${path.basename(file)}`)
  const valid = async (candidate: string) => {
    try { return (await stat(candidate)).size > 0 && Math.abs(await readVideoDurationSeconds(candidate) - duration) <= 0.2 }
    catch { return false }
  }
  if (await valid(output)) return output
  const temporary = path.join(directory, `${randomUUID()}.partial.mp4`)
  const run = async (codec: string[]) => promisify(execFile)(resolveFfmpegExecutablePath(), [
    "-hide_banner", "-nostdin", "-v", "error", "-n", "-i", file,
    "-map", "0:v:0", "-map", "0:a:0?", ...codec, "-movflags", "+faststart", temporary,
  ], { windowsHide: true, signal, maxBuffer: 8 * 1024 * 1024 })
  try {
    onLog(`MOV 转 MP4：${path.basename(file)}`)
    try {
      await run(["-c", "copy"])
    } catch (error) {
      signal.throwIfAborted()
      await rm(temporary, { force: true })
      onLog("MOV 编码不支持直接封装，转为 H.264/AAC 后上传")
      await run(["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac"])
    }
    signal.throwIfAborted()
    if (!await valid(temporary)) throw new Error(`MOV 转 MP4 后时长校验失败：${path.basename(file)}`)
    await rm(output, { force: true })
    await rename(temporary, output)
    return output
  } finally {
    await rm(temporary, { force: true })
  }
}
