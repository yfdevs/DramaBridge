import { spawn, spawnSync } from "node:child_process";
import console from "node:console";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const nativeProxyPreload = fileURLToPath(
  new URL("./node-native-proxy.cjs", import.meta.url),
);

function readUserEnvironmentVariable(name) {
  if (process.platform !== "win32") return undefined;

  const result = spawnSync("reg", ["query", "HKCU\\Environment", "/v", name], {
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.status !== 0) return undefined;

  const match = result.stdout.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, "m"));
  return match?.[1]?.trim();
}

function ensureGitHubToken() {
  const token =
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN ||
    readUserEnvironmentVariable("GH_TOKEN") ||
    readUserEnvironmentVariable("GITHUB_TOKEN");

  if (!token) {
    throw new Error(
      'GitHub Personal Access Token is not set. Set the Windows user env var "GH_TOKEN" before publishing.',
    );
  }

  process.env.GH_TOKEN = token;
  process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || token;

  return token;
}

function configurePublishProxyEnvironment() {
  const allProxy =
    process.env.all_proxy ||
    process.env.ALL_PROXY ||
    readUserEnvironmentVariable("all_proxy") ||
    readUserEnvironmentVariable("ALL_PROXY");
  const httpProxy =
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    readUserEnvironmentVariable("http_proxy") ||
    readUserEnvironmentVariable("HTTP_PROXY") ||
    allProxy;
  const httpsProxy =
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    readUserEnvironmentVariable("https_proxy") ||
    readUserEnvironmentVariable("HTTPS_PROXY") ||
    allProxy ||
    httpProxy;

  // Environment names are case-insensitive on Windows. Keeping an uppercase
  // HTTPS_PROXY would therefore still activate electron-builder 24's legacy
  // https-proxy-agent 5 when it checks lowercase https_proxy. Move the values
  // to private variables and inject Node 24's native proxy agents via preload.
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    delete process.env[name];
  }
  if (httpProxy) process.env.AUTODRAMA_HTTP_PROXY = httpProxy;
  if (httpsProxy) process.env.AUTODRAMA_HTTPS_PROXY = httpsProxy;
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (noProxy) process.env.AUTODRAMA_NO_PROXY = noProxy;

  if (httpProxy || httpsProxy || allProxy) {
    const preloadOption = `--require=${JSON.stringify(nativeProxyPreload)}`;
    process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preloadOption]
      .filter(Boolean)
      .join(" ");
  }

  return { httpProxy, httpsProxy, nativeProxyPreload };
}

function displayProxy(value) {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "configured";
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      shell: true,
      stdio: "inherit",
      windowsHide: true,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      if (signal) {
        reject(new Error(`${command} ${args.join(" ")} was terminated by ${signal}`));
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

try {
  const token = ensureGitHubToken();
  const proxy = configurePublishProxyEnvironment();

  if (process.argv.includes("--check-token")) {
    console.log(`GH_TOKEN is available to the release process (${token.length} chars).`);
    console.log(
      proxy.httpsProxy
        ? `GitHub publishing proxy: ${displayProxy(proxy.httpsProxy)}`
        : "GitHub publishing proxy is not configured; uploads will use a direct connection.",
    );
    process.exit(0);
  }

  await run("pnpm", ["build:app"]);
  if (proxy.httpsProxy) {
    console.log(`Publishing GitHub assets through proxy: ${displayProxy(proxy.httpsProxy)}`);
  }
  await run("node", ["scripts/package-electron-hoisted.mjs", "--win", "--publish", "always"]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
