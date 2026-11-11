import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { YoutubePythonRuntime, type YoutubeRuntimeOptions } from "../src/index.js";

test(
  "managed Python survives runtime recreation and ignores inherited Python environment settings",
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "youtube-environment-"));
    const source = path.join(root, "source");
    const working = path.join(root, "work");
    const names = [
      "PYTHONHOME",
      "PYTHONPATH",
      "VIRTUAL_ENV",
      "UV_PYTHON",
      "UV_PROJECT_ENVIRONMENT",
    ];
    const original = new Map(names.map((name) => [name, process.env[name]]));
    let runtime = new YoutubePythonRuntime();
    const logs: string[] = [];
    const options: YoutubeRuntimeOptions = {
      sourceDirectory: source,
      workingDirectory: working,
      pythonExecutable: "",
      mediaDirectories: [],
      settings: { proxy: "", paused: false },
      netdisk: async () => null,
      saveSettings: () => {},
      log: (line) => logs.push(line),
    };
    try {
      await mkdir(path.join(source, "app"), { recursive: true });
      await promisify(execFile)(process.platform === "win32" ? "python" : "python3", [
        "-m",
        "venv",
        "--without-pip",
        path.join(working, "python-env"),
      ]);
      await writeFile(
        path.join(source, "app", "desktop_bridge.py"),
        `import json, os, sys
names = ${JSON.stringify(names)}
observed = {'executable': sys.executable, 'inherited': {name: os.environ[name] for name in names if name in os.environ}}
if '--check' in sys.argv:
    print(json.dumps({'kind': 'environment', 'value': observed}), flush=True)
else:
    sys.stdin.readline()
    print('ENV:' + json.dumps(observed), flush=True)
    print(json.dumps({'kind': 'ready', 'port': 1}), flush=True)
    for line in sys.stdin:
        if json.loads(line).get('kind') == 'stop': break
`,
      );
      for (const name of names) process.env[name] = path.join(root, "unrelated-environment");
      const managed = path.join(
        working,
        "python-env",
        process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        runtime = new YoutubePythonRuntime();
        assert.equal(await runtime.python(options), managed);
        const inspected = (await runtime.inspectEnvironment(options)) as {
          executable: string;
          inherited: Record<string, string>;
        };
        assert.equal(path.normalize(inspected.executable), path.normalize(managed));
        assert.deepEqual(inspected.inherited, {});
        await runtime.start(options);
        assert.equal(runtime.status().running, true);
        const launched = JSON.parse(
          logs
            .filter((line) => line.startsWith("ENV:"))
            .at(-1)!
            .slice(4),
        );
        assert.equal(path.normalize(launched.executable), path.normalize(managed));
        assert.deepEqual(launched.inherited, {});
        await runtime.stop();
      }
    } finally {
      await runtime.stop();
      for (const [name, value] of original) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
