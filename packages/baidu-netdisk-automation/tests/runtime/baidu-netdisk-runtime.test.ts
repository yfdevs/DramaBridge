import assert from "node:assert/strict";
import test from "node:test";
import { execa } from "execa";
import { baiduProcessQueryCommand } from "../../src/runtime/baidu-netdisk-runtime.js";

test("Windows process discovery succeeds when only one requested process exists", {
  skip: process.platform !== "win32",
}, async () => {
  const command = baiduProcessQueryCommand.replace(
    "@('BaiduNetdisk','BaiduNetdiskUnite')",
    "@('DramaBridgeNonexistentProcessForTest','node')",
  );
  const { stdout } = await execa("powershell.exe", ["-NoProfile", "-Command", command], { windowsHide: true });
  assert.ok(stdout.split(/\r?\n/).some((name) => name.trim().toLowerCase() === "node"));
});
