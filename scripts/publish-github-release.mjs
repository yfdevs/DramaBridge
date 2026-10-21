import console from "node:console";
import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Transform } from "node:stream";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const apiVersion = "2022-11-28";
const maximumAttempts = 5;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const owner = argument("--owner");
const repository = argument("--repo");

function requestHeaders(extra = {}) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "DramaBridge-release",
    "x-github-api-version": apiVersion,
    ...extra,
  };
}

async function responseError(response) {
  const body = await response.text().catch(() => "");
  const suffix = body.trim() ? `: ${body.trim().slice(0, 1_000)}` : "";
  return new Error(`GitHub API ${response.status} ${response.statusText}${suffix}`);
}

function shouldRetryStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function nonRetryable(error) {
  return Object.assign(error, { retryable: false });
}

async function fetchWithRetry(url, options, acceptedStatuses, label) {
  let lastError;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const response = await globalThis.fetch(url, {
        ...options,
        signal: globalThis.AbortSignal.timeout(60_000),
      });
      if (acceptedStatuses.includes(response.status)) return response;
      const error = await responseError(response);
      if (!shouldRetryStatus(response.status)) throw nonRetryable(error);
      lastError = error;
    } catch (error) {
      if (error?.retryable === false) throw error;
      lastError = error;
    }
    if (attempt < maximumAttempts) {
      const delay = Math.min(30_000, 2_000 * (2 ** (attempt - 1)));
      console.warn(`${label}失败，${delay / 1_000} 秒后重试（${attempt}/${maximumAttempts}）`);
      await wait(delay);
    }
  }
  throw new Error(`${label}连续 ${maximumAttempts} 次失败`, { cause: lastError });
}

async function requestJson(url, options, acceptedStatuses, label) {
  const response = await fetchWithRetry(url, options, acceptedStatuses, label);
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

async function resolveRelease(tagName) {
  const releasesUrl = `https://api.github.com/repos/${owner}/${repository}/releases`;
  const response = await fetchWithRetry(
    `${releasesUrl}/tags/${encodeURIComponent(tagName)}`,
    { headers: requestHeaders() },
    [200, 404],
    "查询 GitHub Release",
  );
  if (response.status === 200) return response.json();

  console.log(`创建 GitHub Release：${tagName}`);
  return requestJson(releasesUrl, {
    body: JSON.stringify({
      draft: false,
      name: tagName,
      prerelease: false,
      tag_name: tagName,
    }),
    headers: requestHeaders({ "content-type": "application/json" }),
    method: "POST",
  }, [201], "创建 GitHub Release");
}

async function removeExistingAsset(releaseId, fileName) {
  const release = await requestJson(
    `https://api.github.com/repos/${owner}/${repository}/releases/${releaseId}`,
    { headers: requestHeaders() },
    [200],
    `查询发布文件 ${fileName}`,
  );
  const asset = release.assets?.find((candidate) => candidate.name === fileName);
  if (!asset) return;
  await fetchWithRetry(
    `https://api.github.com/repos/${owner}/${repository}/releases/assets/${asset.id}`,
    { headers: requestHeaders(), method: "DELETE" },
    [204],
    `删除旧发布文件 ${fileName}`,
  );
}

function contentType(fileName) {
  if (fileName.endsWith(".exe")) return "application/vnd.microsoft.portable-executable";
  if (fileName.endsWith(".yml")) return "application/yaml";
  return "application/octet-stream";
}

function uploadStream(filePath, size) {
  let uploaded = 0;
  let displayedPercentage = -1;
  let progressVisible = false;
  const fileName = path.basename(filePath);

  function render(forceComplete = false) {
    if (!process.stdout.isTTY) return;
    const percentage = forceComplete ? 100 : Math.min(100, Math.floor((uploaded / size) * 100));
    if (percentage === displayedPercentage) return;
    displayedPercentage = percentage;
    progressVisible = true;
    const barWidth = 30;
    const completedWidth = Math.round((percentage / 100) * barWidth);
    const bar = `${"█".repeat(completedWidth)}${"░".repeat(barWidth - completedWidth)}`;
    const uploadedMb = (Math.min(uploaded, size) / 1024 / 1024).toFixed(1);
    const totalMb = (size / 1024 / 1024).toFixed(1);
    process.stdout.write(`\r上传进度：${fileName} [${bar}] ${String(percentage).padStart(3)}% ${uploadedMb}/${totalMb} MB`);
  }

  function finish() {
    render(true);
    if (progressVisible) process.stdout.write("\n");
    progressVisible = false;
  }

  function interrupt() {
    if (progressVisible) process.stdout.write("\n");
    progressVisible = false;
  }

  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      uploaded += chunk.length;
      render();
      callback(null, chunk);
    },
  });
  return { body: createReadStream(filePath).pipe(progress), finish, interrupt };
}

async function uploadAsset(releaseId, filePath) {
  const fileName = path.basename(filePath);
  const { size } = await stat(filePath);
  let lastError;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    let progress;
    try {
      await removeExistingAsset(releaseId, fileName);
      console.log(`上传发布文件：${fileName}（${Math.ceil(size / 1024 / 1024)} MB）`);
      progress = uploadStream(filePath, size);
      const response = await globalThis.fetch(
        `https://uploads.github.com/repos/${owner}/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(fileName)}`,
        {
          body: progress.body,
          duplex: "half",
          headers: requestHeaders({
            "content-length": String(size),
            "content-type": contentType(fileName),
          }),
          method: "POST",
          signal: globalThis.AbortSignal.timeout(60 * 60_000),
        },
      );
      if (response.status === 201) {
        await response.arrayBuffer();
        progress.finish();
        console.log(`上传完成：${fileName}`);
        return;
      }
      progress.interrupt();
      progress = undefined;
      lastError = await responseError(response);
      if (!shouldRetryStatus(response.status) && response.status !== 422) {
        throw nonRetryable(lastError);
      }
    } catch (error) {
      progress?.interrupt();
      if (error?.retryable === false) throw error;
      lastError = error;
    }

    if (attempt < maximumAttempts) {
      const delay = Math.min(30_000, 3_000 * (2 ** (attempt - 1)));
      console.warn(`上传失败，${delay / 1_000} 秒后重试：${fileName}（${attempt}/${maximumAttempts}）`);
      await wait(delay);
    }
  }
  throw new Error(`上传连续 ${maximumAttempts} 次失败：${fileName}`, { cause: lastError });
}

async function main() {
  if (!owner || !repository) throw new Error("缺少 GitHub 仓库参数 --owner/--repo");
  if (!token) throw new Error("缺少 GH_TOKEN 或 GITHUB_TOKEN");

  const packageJson = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
  const version = packageJson.version;
  const releaseDir = path.join(rootDir, "release", version);
  const installerName = `DramaBridge-Windows-${version}-Setup.exe`;
  const files = [
    path.join(releaseDir, installerName),
    path.join(releaseDir, `${installerName}.blockmap`),
    path.join(releaseDir, "latest.yml"),
  ];
  await Promise.all(files.map((file) => access(file)));

  if (process.argv.includes("--check-files")) {
    console.log(`发布文件已就绪：${files.map((file) => path.basename(file)).join("、")}`);
    return;
  }

  const release = await resolveRelease(`v${version}`);
  for (const file of files) await uploadAsset(release.id, file);
  console.log(`GitHub Release 发布完成：v${version}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.cause) console.error(error.cause);
  process.exit(1);
});
