import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { electronMainExternals, electronRequireBanner } from "../../internal/vite/electron.js";

test("Electron ESM bundle can persist Douyin options and shared platform JSON files", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const cache = path.join(root, ".cache");
  await mkdir(cache, { recursive: true });
  const output = await mkdtemp(path.join(cache, "electron-file-utils-test-"));
  try {
    await build({
      configFile: false,
      logLevel: "error",
      resolve: {
        alias: {
          "@dramabridge/file-utils": path.join(root, "packages/file-utils/src/index.ts"),
          "@dramabridge/automation-logging": path.join(root, "packages/automation-logging/src/index.ts"),
        },
      },
      ssr: { noExternal: true },
      build: {
        ssr: true,
        target: "node20",
        outDir: output,
        emptyOutDir: false,
        rollupOptions: {
          input: {
            "file-utils": path.join(root, "packages/file-utils/src/index.ts"),
            "douyin-dropdown": path.join(root, "packages/douyin-drama-automation/src/shared/dropdown-options.ts"),
            "automation-logging": path.join(root, "packages/automation-logging/src/index.ts"),
          },
          external: electronMainExternals,
          output: { banner: electronRequireBanner, entryFileNames: "[name].mjs" },
        },
      },
    });
    const { writeJsonAtomic } = await import(pathToFileURL(path.join(output, "file-utils.mjs")).href);
    const target = path.join(output, "observations", "dropdown-options.json");
    await writeJsonAtomic(target, { platform: "douyin-drama", version: 1 });
    await writeJsonAtomic(target, { platform: "douyin-drama", version: 2 });
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), {
      platform: "douyin-drama", version: 2,
    });
    const { createDouyinDramaDropdownRecorder } = await import(pathToFileURL(path.join(output, "douyin-dropdown.mjs")).href);
    const recorder = createDouyinDramaDropdownRecorder({ assetDownloadDir: output, onLog: () => {} });
    await recorder.record("audience", ["男频", "女频"]);
    const snapshot = JSON.parse(await readFile(target, "utf8"));
    assert.equal(snapshot.platform, "douyin-drama");
    assert.deepEqual(snapshot.fields.audience, ["男频", "女频"]);
    const { captureAutomationFailureDiagnostics } = await import(pathToFileURL(path.join(output, "automation-logging.mjs")).href);
    for (const platform of [
      "douyin-drama", "wechat-drama", "wechat-miniprogram-drama", "kuaishou-drama",
      "qq-drama", "meituan-drama", "iqiyi-drama", "baidu-drama", "taobao-drama",
      "pinduoduo-drama", "tencent-huolong-drama", "tiktok-drama",
    ]) {
      const diagnostic = await captureAutomationFailureDiagnostics({
        platform,
        runDataDir: path.join(output, platform),
        error: new Error("build regression check"),
      });
      assert.ok(diagnostic, `${platform} must persist its failure record`);
      const record = JSON.parse(await readFile(diagnostic.recordFile, "utf8"));
      assert.equal(record.platform, platform);
    }
  } finally {
    assert.equal(path.dirname(output), cache);
    assert.ok(path.basename(output).startsWith("electron-file-utils-test-"));
    await rm(output, { recursive: true, force: true });
  }
});
