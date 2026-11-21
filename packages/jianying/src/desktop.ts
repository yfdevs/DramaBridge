import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { preparePythonInstaller } from "./python-bootstrap.js";

function command(executable: string, args: string[], signal: AbortSignal, line?: (text: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, signal, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "", pending = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      output += text; pending += text;
      const lines = pending.split(/\r?\n/); pending = lines.pop()!;
      for (const value of lines) line?.(value);
    });
    child.stderr.on("data", (text: string) => { errors = (errors + text).slice(-8000); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(output) : reject(new Error(errors || output.slice(-4000) || `执行器退出：${code}`)));
  });
}

export async function prepareDesktopPython(root: string, signal: AbortSignal, log: (message: string) => void) {
  const probe = ["-c", "import sys,uiautomation,PIL,cv2; print(sys.executable)"];
  try { return (await command("python", probe, signal)).trim(); } catch { signal.throwIfAborted(); }
  const python = path.join(root, "venv", "Scripts", "python.exe");
  try { await command(python, probe, signal); return python; } catch { signal.throwIfAborted(); }
  await mkdir(root, { recursive: true });
  const uv = await preparePythonInstaller(root, signal, log);
  log("正在自动准备剪映桌面执行环境，首次运行需要下载");
  await command(uv, ["venv", "--python", "3.12", "--managed-python", path.dirname(path.dirname(python))], signal);
  await command(uv, ["pip", "install", "--python", python, "uiautomation==2.0.29", "Pillow==12.3.0", "comtypes==1.4.17", "opencv-python-headless==4.12.0.88", "numpy==2.2.6"], signal);
  await command(python, probe, signal);
  return python;
}

export type DesktopResult = { videoClips: number; audioClips: number; totalFrames: number; importedMaterials: number; screenshot: string; screenshots: string[]; videoTracks: number; audioTracks: number; subtitleSegmentsVisible: number; effectsAdded: number; warnings: string[] };
export async function runDesktopWorkflow(python: string, script: string, request: string, signal: AbortSignal, log: (message: string) => void): Promise<DesktopResult> {
  let result: DesktopResult | undefined;
  let workerError: string | undefined;
  try { await command(python, ["-B", script, "--request", request], signal, text => {
    try {
      const event = JSON.parse(text);
      if (event.kind === "progress") log(event.message);
      if (event.kind === "result") result = event.value;
      if (event.kind === "error") workerError = event.message;
    } catch { /* Ignore non-protocol library output. */ }
  }); } catch (error) { throw new Error(workerError || String(error)); }
  if (!result) throw new Error("剪映执行器未返回经过验证的结果");
  return result;
}
