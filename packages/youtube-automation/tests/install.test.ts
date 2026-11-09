import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { YoutubePythonRuntime, type YoutubeRuntimeOptions } from "../src/index.js";
import {
  UV_VERSION,
  preparePythonInstaller,
  uvExecutableFromWheel,
} from "../src/python-bootstrap.js";
import { deflateRawSync } from "node:zlib";

function wheel(name: string, content: Buffer) {
  const encoded = Buffer.from(name),
    compressed = deflateRawSync(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(encoded.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(encoded.length, 28);
  const ending = Buffer.alloc(22);
  ending.writeUInt32LE(0x06054b50);
  ending.writeUInt16LE(1, 8);
  ending.writeUInt16LE(1, 10);
  ending.writeUInt32LE(central.length + encoded.length, 12);
  ending.writeUInt32LE(local.length + encoded.length + compressed.length, 16);
  return Buffer.concat([local, encoded, compressed, central, encoded, ending]);
}
test("bootstrap extracts only the executable and rejects unverified downloads", async () => {
  const bytes = Buffer.from("native executable fixture");
  assert.deepEqual(
    uvExecutableFromWheel(wheel(`uv-${UV_VERSION}.data/scripts/uv`, bytes), "uv"),
    bytes,
  );
  assert.deepEqual(
    uvExecutableFromWheel(wheel(`uv-${UV_VERSION}.data/scripts/uv.exe`, bytes), "uv.exe"),
    bytes,
  );
  assert.throws(() => uvExecutableFromWheel(wheel("../../uv", bytes), "uv"), /未找到/);
  const root = await mkdtemp(path.join(os.tmpdir(), "youtube-uv-verify-"));
  try {
    await assert.rejects(
      preparePythonInstaller(
        root,
        new AbortController().signal,
        () => {},
        async () => new Response(wheel(`uv-${UV_VERSION}.data/scripts/uv`, bytes)),
      ),
      /校验失败|不支持/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "old or missing Python is provisioned automatically and the managed environment is reused",
  { skip: process.platform !== "darwin" || process.arch !== "arm64" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "youtube-install-test-")),
      working = path.join(root, "work"),
      executable = path.join(root, "old-python"),
      trace = path.join(root, "trace");
    const runtime = new YoutubePythonRuntime();
    const fakePython = `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv.includes('-c'))console.log(JSON.stringify({version:[3,12,1],executable:process.argv[1]}));else if(process.argv.includes('venv')){const dest=path.join(process.argv.at(-1),'bin');fs.mkdirSync(dest,{recursive:true});fs.copyFileSync(process.argv[1],path.join(dest,'python'));fs.chmodSync(path.join(dest,'python'),0o755);}else if(process.argv.includes('pip'))console.log('dependencies installed');\n`;
    await writeFile(
      executable,
      `#!${process.execPath}\nconsole.log(JSON.stringify({version:[3,9,6],executable:process.argv[1]}));\n`,
      { mode: 0o755 },
    );
    const uv = path.join(
      working,
      "python-tools",
      `uv-${UV_VERSION}-${process.platform}-${process.arch}`,
      "uv",
    );
    await mkdir(path.dirname(uv), { recursive: true });
    await writeFile(
      uv,
      `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(trace)},'uv:'+JSON.stringify(args)+'\\n');const python=path.join(process.env.UV_PYTHON_INSTALL_DIR,'cpython-3.12','bin','python3');if(args.includes('install')){fs.mkdirSync(path.dirname(python),{recursive:true});fs.writeFileSync(python,${JSON.stringify(fakePython)},{mode:0o755});}else if(args.includes('find'))console.log(python);else console.log('uv ${UV_VERSION}');\n`,
      { mode: 0o755 },
    );
    const options: YoutubeRuntimeOptions = {
      sourceDirectory: root,
      workingDirectory: working,
      pythonExecutable: executable,
      mediaDirectories: [],
      settings: { proxy: "", paused: false },
      netdisk: async () => null,
      saveSettings: () => {},
      log: () => {},
      download: async () => {
        throw Error("Unexpected network request");
      },
    };
    try {
      await runtime.installDependencies(options);
      assert.equal(runtime.status().error, undefined);
      assert.equal(
        await runtime.python(options),
        path.join(working, "python-env", "bin", "python"),
      );
      await runtime.installDependencies({
        ...options,
        pythonExecutable: "",
      });
      const log = await readFile(trace, "utf8");
      assert.equal(
        log.split("\n").filter((line) => line.startsWith("uv:") && line.includes('"install"'))
          .length,
        1,
      );
      assert.equal(log.split("\n").filter((line) => line.includes('"venv"')).length, 1);
      assert.equal(runtime.status().installing, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "failed network setup clears installation state so the user can retry",
  { skip: process.platform !== "darwin" || process.arch !== "arm64" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "youtube-install-offline-"));
    const runtime = new YoutubePythonRuntime();
    const options: YoutubeRuntimeOptions = {
      sourceDirectory: root,
      workingDirectory: root,
      pythonExecutable: "",
      mediaDirectories: [],
      settings: { proxy: "", paused: false },
      netdisk: async () => null,
      saveSettings: () => {},
      log: () => {},
      download: async () => {
        throw Error("offline fixture");
      },
    };
    try {
      await assert.rejects(runtime.installDependencies(options), /offline fixture|不支持/);
      assert.equal(runtime.status().installing, false);
      await assert.rejects(runtime.installDependencies(options), /offline fixture|不支持/);
      assert.equal(runtime.status().installing, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "exit cancels an in-progress bootstrap and blocks concurrent service startup",
  {
    skip: process.platform !== "darwin" || process.arch !== "arm64",
  },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "youtube-install-cancel-"));
    const runtime = new YoutubePythonRuntime();
    let started!: () => void;
    const downloading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const options: YoutubeRuntimeOptions = {
      sourceDirectory: root,
      workingDirectory: root,
      pythonExecutable: "",
      mediaDirectories: [],
      settings: { proxy: "", paused: false },
      netdisk: async () => null,
      saveSettings: () => {},
      log: () => {},
      download: async (_url, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled fixture")), {
            once: true,
          });
          started();
        }),
    };
    try {
      const installing = runtime.installDependencies(options);
      await downloading;
      await assert.rejects(runtime.start(options), /等待 Python/);
      await assert.rejects(runtime.installDependencies(options), /准备 Python 环境/);
      runtime.dispose();
    await assert.rejects(installing, /环境安装已取消/);
      assert.equal(runtime.status().installing, false);
    } finally {
      runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
