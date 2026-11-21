import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("YouTube browser rights preserve upload-only access and resume existing uploaded videos", async () => {
  await promisify(execFile)(process.platform === "win32" ? "python" : "python3", [
    "-X", "utf8", "-B", fileURLToPath(new URL("../python/tests/test_youtube_rights.py", import.meta.url)),
  ], { timeout: 25000, windowsHide: true });
});
