/// <reference types="node" />
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { initializeSingleInstance } from "../../electron/core/single-instance";

function fakeApp(locked: boolean) {
  const events = new EventEmitter(); let quits = 0; let lockCalls = 0;
  const app = Object.assign(events, {
    requestSingleInstanceLock: () => { lockCalls++; return locked; },
    quit: () => { quits++; },
  });
  return { app: app as unknown as Parameters<typeof initializeSingleInstance>[0], events,
    quits: () => quits, lockCalls: () => lockCalls };
}

test("duplicate launches quit before startup and do not register window or shutdown listeners", () => {
  const f = fakeApp(false); let startup = 0; let restored = 0;
  if (initializeSingleInstance(f.app, () => { restored++; })) startup++;
  assert.equal(f.quits(), 1); assert.equal(startup, 0); assert.equal(restored, 0);
  assert.equal(f.events.listenerCount("second-instance"), 0);
  assert.equal(f.events.listenerCount("before-quit"), 0);
});

test("the primary process restores its existing window on subsequent launches", () => {
  const f = fakeApp(true); let restored = 0;
  assert.equal(initializeSingleInstance(f.app, () => { restored++; }), true);
  f.events.emit("second-instance"); f.events.emit("second-instance");
  assert.equal(restored, 2); assert.equal(f.quits(), 0); assert.equal(f.lockCalls(), 1);
});
