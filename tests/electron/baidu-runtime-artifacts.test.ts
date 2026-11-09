import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { execa } from "execa";
import { prepareMacElectronRuntime } from "../../packages/baidu-netdisk-automation/src/runtime/mac-electron-runtime";

const root = process.cwd();
const require = createRequire(import.meta.url);
const automationRequire = createRequire(path.join(root, "packages/baidu-netdisk-automation/package.json"));

test("Electron reuses Node-created runtime caches and removes partially extracted ASAR artifacts", {
  skip: process.platform !== "darwin",
  timeout: 60_000,
}, async () => {
  const cache = path.join(root, ".cache");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(path.join(cache, "baidu-runtime-artifacts-"));
  try {
    const app = path.join(directory, "archive-source");
    await mkdir(app);
    await writeFile(path.join(app, "package.json"), '{"main":"index.js"}');
    await writeFile(path.join(app, "index.js"), "module.exports = 'ASAR fixture';");
    const archive = path.join(directory, "default_app.asar");
    await automationRequire("@electron/asar").createPackage(app, archive);
    const expectedArchiveSha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
    const bytes = Buffer.from("verified ZIP fixture");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const name = "electron-v26.2.0-darwin-arm64.zip";
    const runtimeRoot = path.join(directory, "runtimes");
    const download = async (url: string, destination: string) => {
      await writeFile(destination, url.endsWith("SHASUMS256.txt") ? `${checksum} *${name}\n` : bytes);
    };
    const executable = await prepareMacElectronRuntime("26.2.0", "arm64", runtimeRoot, {
      download,
      extract: async (_archive, target) => {
        await mkdir(path.join(target, "Electron.app/Contents/MacOS"), { recursive: true });
        await mkdir(path.join(target, "Electron.app/Contents/Resources"), { recursive: true });
        await writeFile(path.join(target, "Electron.app/Contents/MacOS/Electron"), "fixture executable, never launch");
        await copyFile(archive, path.join(target, "Electron.app/Contents/Resources/default_app.asar"));
      },
    });

    // Bundle without a TypeScript loader: tsx's runtime hooks can alter
    // Electron's builtin original-fs resolution and would hide the host bug.
    const output = path.join(directory, "module");
    await execa("pnpm", ["exec", "vp", "pack", "packages/baidu-netdisk-automation/src/runtime/mac-electron-runtime.ts",
      "--no-config", "--out-dir", output, "--format", "esm"], { cwd: root, timeout: 30_000 });
    const bootstrap = path.join(directory, "bootstrap.mjs");
    const failureRoot = path.join(directory, "failed-extraction");
    await writeFile(bootstrap, `
      import assert from 'node:assert/strict';
      import { app } from 'electron';
      import { createRequire } from 'node:module';
      const raw = createRequire(import.meta.url)('original-fs').promises;
      app.setPath('userData', ${JSON.stringify(path.join(directory, "profile"))});
      try {
        const { prepareMacElectronRuntime, sha256File } = await import(${JSON.stringify(pathToFileURL(path.join(output, "mac-electron-runtime.mjs")).href)});
        assert.equal(await sha256File(${JSON.stringify(archive)}), ${JSON.stringify(expectedArchiveSha256)});
        const reused = await prepareMacElectronRuntime('26.2.0', 'arm64', ${JSON.stringify(runtimeRoot)}, {
          download: async () => { throw new Error('existing runtime must not download again'); },
          extract: async () => { throw new Error('existing runtime must not be extracted again'); },
        });
        assert.equal(reused, ${JSON.stringify(executable)});
        const original = new Error('original extraction failure');
        await assert.rejects(prepareMacElectronRuntime('26.2.0', 'arm64', ${JSON.stringify(failureRoot)}, {
          download: async (url, destination) => {
            await raw.writeFile(destination, url.endsWith('SHASUMS256.txt') ? ${JSON.stringify(`${checksum} *${name}\n`)} : Buffer.from(${JSON.stringify(bytes.toString())}));
          },
          extract: async (_archive, target) => {
            const resources = target + '/Electron.app/Contents/Resources';
            await raw.mkdir(resources, { recursive: true });
            await raw.copyFile(${JSON.stringify(archive)}, resources + '/default_app.asar');
            throw original;
          },
        }), error => error === original);
        assert.deepEqual(await raw.readdir(${JSON.stringify(failureRoot)}), []);
        console.log('BAIDU_RUNTIME_ARTIFACTS_OK');
        app.exit(0);
      } catch (error) { console.error(error); app.exit(1); }
    `);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = await execa(require("electron"), [bootstrap], { env, timeout: 30_000 });
    assert.match(result.stdout, /BAIDU_RUNTIME_ARTIFACTS_OK/);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
