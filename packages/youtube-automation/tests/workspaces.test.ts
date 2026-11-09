import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

test("task work cleanup protects active tasks, source files, links, and supports failed-task expiry", async () => {
  const result = await promisify(execFile)(process.platform === "win32" ? "python" : "python3", [
    "-B",
    fileURLToPath(new URL("../python/tests/test_task_workspaces.py", import.meta.url)),
  ]);
  assert.match(result.stderr, /Ran 14 tests/);
  assert.match(result.stderr, /OK/);
});
