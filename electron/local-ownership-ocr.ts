import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import sharp from "sharp";
import type { OwnershipProjectProofKind } from "@dramabridge/media-assets";

// Static script embedded in the bundle: no external PowerShell asset or path interpolation.
const workerScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
  $taskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1
  } | Select-Object -First 1
  function Await-WinRT($Operation, [Type]$ResultType) {
    $task = $taskMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.GetAwaiter().GetResult()
  }
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) { throw 'OCR_LANGUAGE_UNAVAILABLE' }
  [Console]::WriteLine('READY')
  while ($null -ne ($line = [Console]::ReadLine())) {
    try {
      $request = $line | ConvertFrom-Json
      $texts = @()
      foreach ($imagePath in $request.files) {
        $file = Await-WinRT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imagePath)) ([Windows.Storage.StorageFile])
        $stream = Await-WinRT ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        try {
          $decoder = Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
          $bitmap = Await-WinRT ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
          try {
            $result = Await-WinRT ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
            $texts += $result.Text
          } finally { $bitmap.Dispose() }
        } finally { $stream.Dispose() }
      }
      [Console]::WriteLine((@{ texts = $texts } | ConvertTo-Json -Compress))
    } catch { [Console]::WriteLine((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress)) }
  }
} catch { [Console]::WriteLine((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress)); exit 1 }
`;

export function classifyOwnershipOcrText(text: string): OwnershipProjectProofKind {
  const normalized = text.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
  const jianying = /jianyingpro|capcut|剪映/u.test(normalized);
  const juchuang = /seedance|jimeng\.jianying\.com|即梦ai|dreamina|liblib|guagu|剧创/u.test(normalized)
    || (normalized.includes("火山引擎") && /分镜|生成/u.test(normalized));
  return jianying === juchuang ? "unknown" : jianying ? "jianying" : "juchuang";
}

export type LocalOcrTestResult = { available: boolean; message: string; latencyMs?: number };

export class WindowsOwnershipOcr {
  private worker?: ChildProcessWithoutNullStreams;
  private pending?: { resolve: (line: string) => void; reject: (error: Error) => void };
  private queue: Promise<unknown> = Promise.resolve();
  private unavailableUntil = 0;
  private stopped = false;
  private readonly cache = new Map<string, OwnershipProjectProofKind>();

  private receive(timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.reset(new Error("OCR_TIMEOUT")), timeoutMs);
      this.pending = {
        resolve: line => { clearTimeout(timer); this.pending = undefined; resolve(line); },
        reject: error => { clearTimeout(timer); this.pending = undefined; reject(error); },
      };
    });
  }

  private reset(error: Error) {
    this.pending?.reject(error);
    const worker = this.worker;
    this.worker = undefined;
    worker?.kill();
  }

  private async recognize(files: string[], force = false): Promise<string[]> {
    const job = this.queue.catch(() => undefined).then(async () => {
      if (this.stopped || process.platform !== "win32") throw new Error("OCR_UNSUPPORTED");
      if (!force && Date.now() < this.unavailableUntil) throw new Error("OCR_UNAVAILABLE");
      try {
        if (!this.worker) {
          const ready = this.receive(12_000);
          const worker = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
            Buffer.from(workerScript, "utf16le").toString("base64")], { windowsHide: true, shell: false });
          this.worker = worker;
          createInterface({ input: worker.stdout }).on("line", line => {
            if (this.worker === worker) this.pending?.resolve(line);
          });
          worker.stderr.resume();
          worker.stdin.on("error", error => { if (this.worker === worker) this.reset(error); });
          worker.on("error", error => { if (this.worker === worker) this.reset(error); });
          worker.on("exit", () => { if (this.worker === worker) this.reset(new Error("OCR_EXITED")); });
          if (await ready !== "READY") throw new Error("OCR_UNAVAILABLE");
        }
        const response = this.receive(8_000);
        this.worker.stdin.write(`${JSON.stringify({ files })}\n`);
        const result = JSON.parse(await response) as { error?: string; texts?: string[] };
        if (result.error || !Array.isArray(result.texts)) throw new Error("OCR_RECOGNITION_FAILED");
        this.unavailableUntil = 0;
        return result.texts;
      } catch (error) {
        this.unavailableUntil = Date.now() + 60_000;
        this.reset(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    });
    this.queue = job;
    return job;
  }

  async classify(file: string): Promise<OwnershipProjectProofKind> {
    if (this.stopped || process.platform !== "win32" || Date.now() < this.unavailableUntil) return "unknown";
    let directory: string | undefined;
    try {
      // Identity is read from application chrome and draft paths, not video captions.
      const image = await sharp(file).rotate().png().toBuffer();
      const { width, height } = await sharp(image).metadata();
      if (!width || !height || width < 4 || height < 4) return "unknown";
      const { createHash } = await import("node:crypto");
      const key = createHash("sha256").update(image).digest("hex");
      const cached = this.cache.get(key);
      if (cached) return cached;
      directory = await mkdtemp(path.join(os.tmpdir(), "dramabridge-ocr-"));
      const regions = [
        { left: 0, top: 0, width, height: Math.max(1, Math.round(height * 0.25)), scale: 1 },
        { left: Math.round(width * 0.74), top: Math.round(height * 0.045),
          width: width - Math.round(width * 0.74), height: Math.max(1, Math.round(height * 0.38) - Math.round(height * 0.045)), scale: 2 },
      ];
      const files = await Promise.all(regions.map(async (region, index) => {
        const target = path.join(directory!, `${index}.png`);
        const ratio = Math.min(region.scale, 2400 / Math.max(region.width, region.height));
        await sharp(image).extract({ left: region.left, top: region.top, width: region.width, height: region.height })
          .resize(Math.max(1, Math.round(region.width * ratio)), Math.max(1, Math.round(region.height * ratio)), { kernel: "linear" })
          .png().toFile(target);
        return target;
      }));
      const kind = classifyOwnershipOcrText((await this.recognize(files)).join("\n"));
      if (kind !== "unknown") {
        if (this.cache.size >= 512) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, kind);
      }
      return kind;
    } catch { return "unknown"; }
    finally { if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
  }

  async test(): Promise<LocalOcrTestResult> {
    if (process.platform !== "win32") return { available: false, message: "这台电脑不支持本机识别，将使用 AI 识别。" };
    let directory: string | undefined;
    const started = Date.now();
    try {
      directory = await mkdtemp(path.join(os.tmpdir(), "dramabridge-ocr-test-"));
      const file = path.join(directory, "test.png");
      await sharp(Buffer.from('<svg width="800" height="120"><rect width="100%" height="100%" fill="white"/><text x="30" y="80" font-family="Arial" font-size="48" fill="black">OCR TEST 123</text></svg>')).png().toFile(file);
      const text = (await this.recognize([file], true)).join("").replace(/\s+/gu, "").toUpperCase();
      if (!text.includes("OCRTEST123")) throw new Error("OCR_TEST_FAILED");
      return { available: true, message: "本机识别可用，无法确认的截图会自动交给 AI。", latencyMs: Date.now() - started };
    } catch {
      return { available: false, message: "本机识别暂不可用，可能缺少系统识别组件。任务会自动使用 AI。" };
    } finally { if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined); }
  }

  stop() {
    this.stopped = true;
    this.reset(new Error("OCR_STOPPED"));
    this.cache.clear();
  }
}
