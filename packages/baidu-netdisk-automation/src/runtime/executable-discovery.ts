import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";

export function normalizeBaiduInstallPath(value: string) {
  return value
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .trim();
}

export function baiduDirectoryExecutableCandidates(directory: string) {
  return [
    path.join(directory, "module", "BrowserEngine", "BaiduNetdiskUnite.exe"),
    path.join(directory, "BaiduNetdiskUnite.exe"),
    path.join(directory, "BaiduNetdisk.exe"),
  ];
}

export function defaultBaiduInstallRoots(options: {
  appData?: string;
  localAppData?: string;
  homeDir: string;
}) {
  const join = path.win32.join;
  const roots = [
    options.appData ? join(options.appData, "baidu", "BaiduNetdisk") : undefined,
    options.localAppData ? join(options.localAppData, "baidu", "BaiduNetdisk") : undefined,
    join(options.homeDir, "AppData", "Roaming", "baidu", "BaiduNetdisk"),
    ...["C:\\", "D:\\", "E:\\", "F:\\"].flatMap((drive) => [
      join(drive, "BaiduNetdisk"),
      join(drive, "baidu", "BaiduNetdisk"),
      join(drive, "Program Files", "BaiduNetdisk"),
      join(drive, "Program Files (x86)", "BaiduNetdisk"),
    ]),
  ];
  return [...new Set(roots.filter((root): root is string => Boolean(root)))];
}

const installationQuery = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Get-Process -Name BaiduNetdisk,BaiduNetdiskUnite | ForEach-Object { $_.Path }
foreach ($key in @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\BaiduNetdisk.exe',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\BaiduNetdisk.exe',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\BaiduNetdisk.exe'
)) {
  $item = Get-ItemProperty -LiteralPath $key
  if ($item) { $item.'(default)'; $item.Path }
}
foreach ($key in @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)) {
  Get-ItemProperty -Path $key | Where-Object { $_.DisplayName -match '百度网盘|BaiduNetdisk' } |
    ForEach-Object { $_.InstallLocation; $_.DisplayIcon }
}
`;

let hints: { expires: number; promise: Promise<string[]> } | undefined;
async function windowsInstallHints() {
  if (process.platform !== "win32") return [];
  if (!hints || hints.expires < Date.now()) {
    hints = {
      expires: Date.now() + 30_000,
      promise: execa(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", installationQuery],
        {
          windowsHide: true,
          // Missing registry branches may set a failure exit code after valid hints were printed.
          reject: false,
          timeout: 5000,
        },
      )
        .then(({ stdout }) =>
          stdout
            .split(/\r?\n/)
            .map((line) => normalizeBaiduInstallPath(line.replace(/,\s*-?\d+$/, "")))
            .filter(Boolean),
        )
        .catch(() => []),
    };
  }
  return hints.promise;
}

async function kind(location: string) {
  return stat(location).then(
    (info) => (info.isFile() ? "file" : info.isDirectory() ? "directory" : null),
    () => null,
  );
}

async function executableInDirectory(directory: string) {
  for (const candidate of baiduDirectoryExecutableCandidates(directory)) {
    if ((await kind(candidate)) === "file") return candidate;
  }
  return undefined;
}

export async function findBaiduNetdiskExecutable(explicitPath?: string) {
  const explicit = normalizeBaiduInstallPath(explicitPath ?? "");
  if (explicit) {
    const explicitKind = await kind(explicit);
    if (explicitKind === "file") return explicit;
    if (explicitKind === "directory") {
      const executable = await executableInDirectory(explicit);
      if (executable) return executable;
      throw new Error(`所选目录中没有找到百度网盘，请选择 BaiduNetdisk 安装文件夹：${explicit}`);
    }
    throw new Error(`百度网盘安装目录或启动文件不存在：${explicit}`);
  }

  const defaults = defaultBaiduInstallRoots({
    appData: process.env.APPDATA,
    localAppData: process.env.LOCALAPPDATA,
    homeDir: os.homedir(),
  });
  // Check common roots first so routine status checks need no registry subprocess.
  for (const root of defaults) {
    const executable = await executableInDirectory(root);
    if (executable) return executable;
  }
  for (const hint of await windowsInstallHints()) {
    const directory = /\.exe$/i.test(hint) ? path.dirname(hint) : hint;
    const executable = await executableInDirectory(directory);
    if (executable) return executable;
  }
  throw new Error(
    "没有找到百度网盘，请选择安装文件夹，例如 D:\\BaiduNetdisk，无需查找里面的 exe 文件。",
  );
}
