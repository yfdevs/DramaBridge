import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

// Pinned upstream PyPI wheels and SHA-256 digests. No remote installer scripts run.
export const UV_VERSION = "0.13.7";
const assets: Record<string, { url: string; sha256: string }> = {
  "darwin-arm64": {
    url: "https://files.pythonhosted.org/packages/40/a5/8756c38ace102fa13fd4e653e8bc40e1f65924f1c0a0d23350339dac97e5/uv-0.13.7-py3-none-macosx_11_0_arm64.whl",
    sha256: "f91a229093163eefca89ea1b220a221d64c3beade05d03519a6584d1797a5a5f",
  },
  "win32-x64": {
    url: "https://files.pythonhosted.org/packages/8e/4f/041b59d2a38807a3e31ef41064cf3e45d2752fe0409d89040d52778049ae/uv-0.13.7-py3-none-win_amd64.whl",
    sha256: "2835e2ab397d0db86323b9975dce75ecd76aa9cfa0d6a2aea84734aae7f8c9b3",
  },
  "win32-arm64": {
    url: "https://files.pythonhosted.org/packages/44/8d/1594dce4465d9699467a639b25aafd335ce1e5917f8bb60c9c0bed9e0859/uv-0.13.7-py3-none-win_arm64.whl",
    sha256: "55e741a380a98008fc4985cf069855f36bc50242ef438e21a466786f5bc84da8",
  },
};

// Extract only the expected executable from a verified wheel, never archive paths.
export function uvExecutableFromWheel(archive: Buffer, executable: string): Buffer {
  for (
    let position = archive.length - 22;
    position >= Math.max(0, archive.length - 65557);
    position--
  ) {
    if (archive.readUInt32LE(position) !== 0x06054b50) continue;
    if (position + 22 + archive.readUInt16LE(position + 20) !== archive.length) continue;
    let entry = archive.readUInt32LE(position + 16);
    const count = archive.readUInt16LE(position + 10);
    for (let index = 0; index < count; index++) {
      if (entry + 46 > archive.length || archive.readUInt32LE(entry) !== 0x02014b50)
        throw new Error("安装工具压缩包无效");
      const method = archive.readUInt16LE(entry + 10),
        compressed = archive.readUInt32LE(entry + 20),
        size = archive.readUInt32LE(entry + 24);
      const nameLength = archive.readUInt16LE(entry + 28),
        extra = archive.readUInt16LE(entry + 30),
        comment = archive.readUInt16LE(entry + 32);
      const name = archive.subarray(entry + 46, entry + 46 + nameLength).toString("utf8");
      if (
        name === `uv/${executable}` ||
        (/^uv-[^/]+\.data\/scripts\//.test(name) && name.split("/").slice(-1)[0] === executable)
      ) {
        const local = archive.readUInt32LE(entry + 42);
        if (
          size > 256 * 1024 * 1024 ||
          local + 30 > archive.length ||
          archive.readUInt32LE(local) !== 0x04034b50
        )
          throw new Error("安装工具压缩包无效");
        const start =
          local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
        if (start + compressed > archive.length) throw new Error("安装工具下载不完整");
        const content = archive.subarray(start, start + compressed);
        const binary =
          method === 0
            ? Buffer.from(content)
            : method === 8
              ? inflateRawSync(content, { maxOutputLength: 256 * 1024 * 1024 })
              : null;
        if (!binary || binary.length !== size) throw new Error("安装工具解压失败");
        return binary;
      }
      entry += 46 + nameLength + extra + comment;
    }
    break;
  }
  throw new Error("安装包中未找到 Python 安装工具");
}
export type BootstrapDownload = (url: string, signal: AbortSignal) => Promise<Response>;
export async function preparePythonInstaller(
  root: string,
  signal: AbortSignal,
  log: (text: string) => void,
  download: BootstrapDownload = (url, signal) => fetch(url, { signal }),
): Promise<string> {
  const key = `${process.platform}-${process.arch}`,
    asset = assets[key];
  if (!asset) throw new Error("当前系统暂不支持自动下载 Python，请手动选择 Python 3.12");
  const directory = path.join(root, "python-tools", `uv-${UV_VERSION}-${key}`);
  const name = process.platform === "win32" ? "uv.exe" : "uv",
    target = path.join(directory, name);
  if (
    await access(target).then(
      () => true,
      () => false,
    )
  )
    return target;
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.download-${randomUUID()}`);
  try {
    log("下载 Python 安装工具");
    const timeout = AbortSignal.timeout(180000);
    const response = await download(asset.url, AbortSignal.any([signal, timeout]));
    if (!response.ok || !response.body)
      throw new Error(`安装工具下载失败（HTTP ${response.status}）`);
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      signal.throwIfAborted();
      length += chunk.byteLength;
      if (length > 128 * 1024 * 1024) throw new Error("安装工具文件过大");
      chunks.push(Buffer.from(chunk));
    }
    const archive = Buffer.concat(chunks);
    if (createHash("sha256").update(archive).digest("hex") !== asset.sha256)
      throw new Error("安装工具校验失败，请重试");
    await writeFile(temporary, uvExecutableFromWheel(archive, name), { mode: 0o755 });
    signal.throwIfAborted();
    await rename(temporary, target);
    log("Python 安装工具已准备");
    return target;
  } finally {
    await rm(temporary, { force: true });
  }
}
