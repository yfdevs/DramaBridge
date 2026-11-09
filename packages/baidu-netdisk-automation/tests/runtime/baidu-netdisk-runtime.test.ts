import assert from "node:assert/strict";
import test from "node:test";
import { execa } from "execa";
import { baiduProcessQueryCommand, parseMacBaiduProcesses, stopMacBaiduNetdiskProcesses, stopBaiduNetdiskProcesses } from "../../src/runtime/baidu-netdisk-runtime.js";

test("Mac process discovery selects client mains without matching helper processes or arguments", () => {
  assert.deepEqual(parseMacBaiduProcesses(`
  10 /Applications/BaiduNetdisk.app/Contents/MacOS/BaiduNetdisk
  11 /Applications/BaiduNetdisk.app/Contents/Frameworks/BaiduNetdisk Helper.app/Contents/MacOS/BaiduNetdisk Helper
  12 /Users/test/Library/Application Support/DramaBridge/mac-cache/BaiduNetdisk.app/Contents/MacOS/BaiduNetdisk
  13 /usr/bin/node
  14 /Users/test/Library/Application Support/DramaBridge/Electron.app/Contents/MacOS/Electron /cache/mac-123/app --dramabridge-baidu-netdisk --remote-debugging-port=9337
  15 /Applications/Electron.app/Contents/MacOS/Electron /unrelated/app
  16 /Applications/Electron.app/Contents/MacOS/Electron --type=renderer --dramabridge-baidu-netdisk
  `), [
    { pid: 10, executable: "/Applications/BaiduNetdisk.app/Contents/MacOS/BaiduNetdisk" },
    { pid: 12, executable: "/Users/test/Library/Application Support/DramaBridge/mac-cache/BaiduNetdisk.app/Contents/MacOS/BaiduNetdisk" },
    { pid: 14, executable: "/Users/test/Library/Application Support/DramaBridge/Electron.app/Contents/MacOS/Electron" },
  ]);
});

test("Mac restart waits for actual exit and tolerates a process exiting before SIGTERM", async () => {
  let running = [{ pid: 10, executable: "/Applications/BaiduNetdisk.app/Contents/MacOS/BaiduNetdisk" }];
  const signals: number[] = [];
  await stopMacBaiduNetdiskProcesses({
    list: async () => running,
    terminate: pid => { signals.push(pid); },
    wait: async () => { running = []; },
  });
  assert.deepEqual(signals, [10]);
  running = [{ pid: 11, executable: "fixture" }];
  await stopMacBaiduNetdiskProcesses({
    list: async () => running,
    terminate: () => { running = []; throw new Error("ESRCH"); },
    wait: async () => {},
  });
});

test("Mac restart refuses to proceed when the previous client remains running", async () => {
  await assert.rejects(stopMacBaiduNetdiskProcesses({
    list: async () => [{ pid: 10, executable: "fixture" }],
    terminate: () => {}, wait: async () => {},
  }, 0), /未能退出/);
});

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
