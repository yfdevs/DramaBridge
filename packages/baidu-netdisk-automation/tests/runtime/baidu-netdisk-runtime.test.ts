import assert from "node:assert/strict";
import test from "node:test";
import { execa } from "execa";
import { baiduProcessQueryCommand, stopBaiduNetdiskProcesses } from "../../src/runtime/baidu-netdisk-runtime.js";

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

for (const scenario of ["parent tree removes engine", "engine exits during taskkill"]) {
  test(`process cleanup tolerates ${scenario}`, async () => {
    let running = ["BaiduNetdisk", "BaiduNetdiskUnite"];
    const killed: string[] = [];
    await stopBaiduNetdiskProcesses({
      getRunningProcesses: async () => [...running],
      killProcess: async (name) => {
        killed.push(name);
        running = scenario === "parent tree removes engine" ? [] : running.filter((item) => item !== name);
        if (name === "BaiduNetdiskUnite") throw new Error("taskkill exit code 255");
        return "";
      },
    });
    assert.deepEqual(killed, scenario === "parent tree removes engine" ? ["BaiduNetdisk"] : ["BaiduNetdisk", "BaiduNetdiskUnite"]);
  });
}

test("process cleanup still rejects when taskkill fails and the process remains", async () => {
  const failure = new Error("access denied");
  await assert.rejects(stopBaiduNetdiskProcesses({
    getRunningProcesses: async () => ["BaiduNetdiskUnite"],
    killProcess: async () => { throw failure; },
  }), (error: unknown) => error instanceof Error && error.cause === failure && /残留进程：BaiduNetdiskUnite/.test(error.message));
});
