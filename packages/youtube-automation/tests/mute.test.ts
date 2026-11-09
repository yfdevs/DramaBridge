import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
test("mute validates options, isolates output, merges mixed audio and only keeps smaller compression", async () => {
  const result = await promisify(execFile)(
    process.platform === "win32" ? "python" : "python3",
    ["-B", fileURLToPath(new URL("../python/tests/test_mute.py", import.meta.url))],
    {
      env: {
        ...process.env,
        PATH: [
          path.dirname(require("ffmpeg-static")),
          process.platform === "darwin" && process.arch === "arm64"
            ? path.dirname(require.resolve("@ffprobe-installer/darwin-arm64/package.json"))
            : path.dirname(require("ffprobe-static").path),
          process.env.PATH,
        ].join(path.delimiter),
      },
    },
  );
  assert.match(result.stderr, /Ran 3 tests/);
  assert.match(result.stderr, /OK/);
});
