import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type TranscriptionState = {
  status: "idle" | "running" | "success" | "failed" | "cancelled";
  message: string;
  source?: string;
  text?: string;
  sentenceCount?: number;
  output?: string;
  textPath?: string;
  subtitlePath?: string;
};
export type TranscriptionRuntime = { bun: string; cli: string };
export type TranscriptSentence = { text: string; startUs: number; endUs: number };

// Keep user paths in argv, never interpolate them into executable JavaScript or a shell.
const HOST_SCRIPT = `
const { spawn } = require("node:child_process");
const child = spawn(process.argv[1], process.argv.slice(2), { stdio: "inherit", windowsHide: true });
child.on("error", () => { console.error("Cannot start Jianying ASR CLI"); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
`;

export async function findTranscriptionRuntime(appsDirectory: string, executable?: string): Promise<TranscriptionRuntime> {
  const versions = (await readdir(appsDirectory, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && /^\d+(?:\.\d+)+$/.test(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  const directories = [...new Set([
    ...(executable ? [path.dirname(executable)] : []),
    ...versions.map(version => path.join(appsDirectory, version)), appsDirectory,
  ])];
  for (const directory of directories) {
    const runtime = { bun: path.join(directory, "vebun.exe"), cli: path.join(directory, "lyra-cli.exe") };
    if ((await Promise.all(Object.values(runtime).map(file => stat(file).catch(() => null)))).every(file => file?.isFile())) return runtime;
  }
  throw new Error("未找到剪映的字幕识别组件，请安装新版剪映，或在配置管理中选择剪映主程序。");
}

export async function runTranscriptionHost(
  runtime: TranscriptionRuntime, args: string[], signal?: AbortSignal, timeoutMs = 610_000,
): Promise<{ stdout: string; exitCode: number | null }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.bun, ["-e", HOST_SCRIPT, "--", runtime.cli, ...args], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let failure: Error | undefined;
    let stopping = false;
    const stop = (error: Error) => {
      if (stopping) return;
      stopping = true;
      failure = error;
      if (process.platform === "win32" && child.pid) {
        execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {
          if (child.exitCode === null) child.kill();
        });
      } else child.kill("SIGKILL");
    };
    const abort = () => stop(new DOMException("已停止字幕识别", "AbortError"));
    const timer = setTimeout(() => stop(new Error("字幕识别超过 10 分钟，已停止。请缩短视频后重试。")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) stop(new Error("字幕结果过大，请分段识别视频。"));
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    child.once("error", () => { cleanup(); reject(new Error("无法启动剪映识别组件，请检查剪映安装是否完整。")); });
    child.once("close", exitCode => {
      cleanup();
      if (failure) reject(failure);
      else {
        const stdout = Buffer.concat(chunks).toString("utf8").trim();
        if (!stdout) reject(new Error(stderr ? "剪映识别组件未返回结果，请检查剪映登录状态。" : "剪映识别组件未返回结果。"));
        else resolve({ stdout, exitCode });
      }
    });
  });
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function transcriptionError(code: unknown, message: unknown): Error {
  const detail = typeof message === "string" ? message : "";
  if (/unauthorized host process/i.test(detail)) return new Error("剪映拒绝了识别进程，请更新剪映后重试。");
  if (/entitlement|membership|subscription|vip|会员/i.test(detail)) return new Error("当前账号没有字幕识别权限，请在剪映中确认会员权益后重试。");
  if ([-100305, -100800].includes(Number(code)) || /auth|login|登录/i.test(detail)) return new Error("请先在剪映中登录账号，再重新识别。");
  if (/no recognized sentence|no recognizable speech|empty transcript/i.test(detail)) return new Error("没有识别到语音，请确认视频中有清晰的人声。");
  if (/timeout|timed.out/i.test(detail)) return new Error("剪映识别超时，请检查网络或缩短视频后重试。");
  // Don't propagate CLI diagnostics that can contain account or authorization data.
  return new Error(`剪映识别失败${typeof code === "number" ? `（错误码 ${code}）` : ""}，请确认视频可播放、含有人声且网络正常。`);
}

export function parseTranscript(value: unknown): TranscriptSentence[] {
  const body = record(value);
  const result = body.result === undefined ? body : record(body.result);
  if (body.err_code !== undefined && body.err_code !== 0) throw transcriptionError(body.err_code, body.err_msg);
  const sentences = result.sentences ?? record(result.asr).sentences;
  if (!Array.isArray(sentences)) throw new Error("剪映返回的字幕格式无法识别，请更新剪映后重试。");
  return sentences.map((value, index) => {
    const sentence = record(value);
    const startUs = sentence.start_us;
    const durationUs = sentence.duration_us;
    const text = sentence.text;
    if (typeof text !== "string" || !text.trim() || typeof startUs !== "number" || !Number.isSafeInteger(startUs) || startUs < 0
      || typeof durationUs !== "number" || !Number.isSafeInteger(durationUs) || durationUs <= 0 || !Number.isSafeInteger(startUs + durationUs)) {
      throw new Error(`剪映返回的第 ${index + 1} 段字幕不完整，未生成字幕文件。`);
    }
    return { text: text.replace(/\r\n?/g, "\n").trim(), startUs, endUs: startUs + durationUs };
  }).sort((a, b) => a.startUs - b.startUs);
}

function srtTime(microseconds: number): string {
  const ms = Math.round(microseconds / 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

export function transcriptFiles(sentences: TranscriptSentence[]): { text: string; srt: string } {
  return {
    text: sentences.map(sentence => sentence.text).join("\r\n"),
    srt: sentences.map((sentence, index) => `${index + 1}\r\n${srtTime(sentence.startUs)} --> ${srtTime(Math.max(sentence.endUs, sentence.startUs + 1000))}\r\n${sentence.text.replace(/\n/g, "\r\n")}\r\n`).join("\r\n"),
  };
}

export async function transcribeVideo(options: {
  source: string; outputRoot: string; runtime: TranscriptionRuntime; signal?: AbortSignal;
  onProgress?: (message: string) => void;
}) {
  const { source, outputRoot, runtime, signal, onProgress } = options;
  signal?.throwIfAborted();
  if (!path.isAbsolute(source) || !(await stat(source)).isFile()) throw new Error("请选择有效的视频文件。");
  onProgress?.("正在检查剪映登录状态");
  const auth = await runTranscriptionHost(runtime, ["auth", "status"], signal, 30_000);
  let authBody: Record<string, unknown>;
  try { authBody = record(JSON.parse(auth.stdout)); } catch { throw new Error("无法读取剪映登录状态，请更新剪映后重试。"); }
  if (auth.exitCode !== 0 || authBody.err_code !== 0 || record(authBody.result).authenticated !== true) throw transcriptionError(authBody.err_code, authBody.err_msg || "login required");
  signal?.throwIfAborted();
  const output = path.join(outputRoot, randomUUID());
  await mkdir(output, { recursive: true });
  const rawPath = path.join(output, "识别原始结果.json");
  onProgress?.("正在识别视频中的语音，请稍候");
  const reply = await runTranscriptionHost(runtime, ["media", "asr", "--input", source, "--language", "auto", "--output", rawPath, "--timeout", "10min"], signal);
  signal?.throwIfAborted();
  let envelope: Record<string, unknown>;
  try { envelope = record(JSON.parse(reply.stdout)); } catch { throw new Error("剪映未返回有效的识别结果，未生成文本。"); }
  if (reply.exitCode !== 0 || envelope.err_code !== 0) throw transcriptionError(envelope.err_code, envelope.err_msg);
  const rawStat = await stat(rawPath).catch(() => null);
  if (rawStat && rawStat.size > 32 * 1024 * 1024) throw new Error("字幕结果过大，请分段识别视频。");
  const receipt: unknown = rawStat ? JSON.parse(await readFile(rawPath, "utf8")) : envelope;
  const sentences = parseTranscript(receipt);
  const { text, srt } = transcriptFiles(sentences);
  signal?.throwIfAborted();
  onProgress?.("正在保存文字和字幕文件");
  const stem = path.parse(source).name;
  const textPath = path.join(output, `${stem}.txt`);
  const subtitlePath = path.join(output, `${stem}.srt`);
  await writeFile(textPath, `\uFEFF${text}`, "utf8");
  await writeFile(subtitlePath, `\uFEFF${srt}`, "utf8");
  signal?.throwIfAborted();
  return { output, textPath, subtitlePath, text, sentenceCount: sentences.length };
}
