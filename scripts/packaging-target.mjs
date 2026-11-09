import path from "node:path";
import process from "node:process";

export function packagingTarget(args, hostPlatform = process.platform, hostArch = process.arch) {
  const platforms = [...new Set(args.filter(arg => ["--mac", "--win", "--windows", "--linux"].includes(arg))
    .map(arg => arg === "--mac" ? "darwin" : arg === "--linux" ? "linux" : "win32"))];
  if (platforms.length > 1) throw new Error("Package one platform per invocation so native dependencies stay aligned.");
  const platform = platforms[0] ?? hostPlatform;
  const architectures = args.filter(arg => ["--arm64", "--x64", "--ia32", "--universal"].includes(arg));
  if (architectures.length > 1) throw new Error("Package one architecture per invocation.");
  const arch = architectures[0]?.slice(2) ?? hostArch;
  if (platform === "darwin" && (hostPlatform !== "darwin" || hostArch !== "arm64" || arch !== "arm64")) {
    throw new Error("Mac builds support Apple Silicon (M-series) only. Use an arm64 Node.js installation on an Apple Silicon Mac or macos-15 in GitHub Actions.");
  }
  return { platform, arch };
}

export function packagedApplication(root, version, platform, arch) {
  const release = path.join(root, "release", version);
  if (platform === "darwin") {
    const contents = path.join(release, `mac-${arch}`, "DramaBridge.app", "Contents");
    return { executable: path.join(contents, "MacOS", "DramaBridge"), resources: path.join(contents, "Resources") };
  }
  if (platform === "win32") {
    const directory = path.join(release, "win-unpacked");
    return { executable: path.join(directory, "DramaBridge.exe"), resources: path.join(directory, "resources") };
  }
  return undefined;
}
