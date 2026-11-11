import assert from "node:assert/strict";
import { test } from "node:test";
import { createAccountRuntimeGroup } from "../../electron/platforms/shared/account-runtime-group";

test("adding and pausing accounts preserves sibling runtimes and existing work", async () => {
  const started: string[] = [],
    stopped: string[] = [];
  const gates = new Map<string, () => boolean>();
  const factory = async (id: string, gate: () => boolean) => {
    if (id === "broken") throw new Error("browser failed");
    started.push(id);
    gates.set(id, gate);
    return {
      getStatus: () => ({ running: true, accounts: [{ accountId: id, launched: true, paused: false }] }),
      stop: async () => {
        stopped.push(id);
      },
    };
  };
  const group = await createAccountRuntimeGroup(["a"], factory);
  await Promise.all([group.addAccount("b"), group.addAccount("b")]);
  assert.deepEqual(started, ["a", "b"]);
  assert.deepEqual(stopped, []);
  group.setAccountPaused("a", true);
  assert.equal(gates.get("a")!(), false);
  assert.equal(gates.get("b")!(), true);
  assert.equal(group.getStatus().accounts[0]!.paused, true);
  assert.deepEqual(stopped, [], "pausing must leave active work and browsers intact");
  group.setAccountPaused("a", false);
  assert.equal(gates.get("a")!(), true);
  await assert.rejects(group.addAccount("broken"), /browser failed/);
  assert.equal(group.getStatus().accounts.length, 2);
  await group.stop();
  assert.deepEqual(stopped.sort(), ["a", "b"]);
  assert.equal(gates.get("b")!(), false);
  await assert.rejects(group.addAccount("c"), /停止/);
});

test("stop during account startup closes the late browser without publishing it", async () => {
  let finish!: () => void;
  let starting!: () => void;
  const entered = new Promise<void>((resolve) => {
    starting = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const closed: string[] = [];
  const group = await createAccountRuntimeGroup(["a"], async (id) => {
    if (id === "b") {
      starting();
      await ready;
    }
    return {
      getStatus: () => ({ running: true, accounts: [{ accountId: id, launched: true, paused: false }] }),
      stop: async () => {
        closed.push(id);
      },
    };
  });
  const addition = group.addAccount("b");
  await entered;
  const stopping = group.stop();
  finish();
  await assert.rejects(addition, /停止/);
  await stopping;
  assert.deepEqual(closed.sort(), ["a", "b"]);
  assert.equal(group.getStatus().accounts.length, 1);
});

test("initial sibling failure preserves successfully started accounts", async () => {
  const group = await createAccountRuntimeGroup(["broken", "a"], async (id) => {
    if (id === "broken") throw new Error("browser failed");
    return {
      getStatus: () => ({ running: true, accounts: [{ accountId: id, launched: true, paused: false }] }),
      stop: async () => {},
    };
  });
  assert.equal(group.getStatus().running, true);
  assert.deepEqual(
    group.getStatus().accounts.map((account) => account.accountId),
    ["a"],
  );
  await group.stop();
});
