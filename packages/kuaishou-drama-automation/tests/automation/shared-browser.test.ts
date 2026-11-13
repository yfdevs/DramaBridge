import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("instance and sync share live login, save updated credentials and close only their own tabs", { timeout: 30_000 }, async () => {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= fileURLToPath(new URL("../../../../.cache/playwright-browsers", import.meta.url));
  const { openKuaishouBrowserContext } = await import("../../src/automation/shared-browser.js");
  const root = await mkdtemp(path.join(tmpdir(), "kuaishou-shared-login-"));
  const server = createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end("<title>test login</title>"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const options = { headless: true, channel: "chromium", credentialStatePath: path.join(root, "credentials.json") };
  const contexts: Awaited<ReturnType<typeof openKuaishouBrowserContext>>[] = [];
  try {
    const [instance, sync] = await Promise.all([
      openKuaishouBrowserContext(path.join(root, "profile"), options),
      openKuaishouBrowserContext(path.join(root, "profile"), options),
    ]);
    contexts.push(instance, sync);
    assert.equal(instance.browser(), sync.browser(), "no competing Chromium processes for the same profile");
    const instancePage = instance.pages()[0] ?? await instance.newPage();
    const syncPage = await sync.newPage();
    await instancePage.goto(url); await syncPage.goto(url);
    await instancePage.evaluate(() => { document.cookie = "login=instance; path=/"; localStorage.setItem("login", "instance"); });
    assert.equal(await syncPage.evaluate(() => localStorage.getItem("login")), "instance");
    assert.ok((await sync.cookies()).some(cookie => cookie.name === "login" && cookie.value === "instance"));
    await syncPage.evaluate(() => { document.cookie = "login=sync; path=/"; localStorage.setItem("login", "sync"); });
    await instance.addCookies([{ name: "persistent", value: "analytics", url, expires: Date.now() / 1000 + 86400 }]);
    assert.ok((await instance.cookies()).some(cookie => cookie.value === "sync"));
    assert.ok(!instance.pages().includes(syncPage));
    await Promise.all([sync.close(), sync.close()]);
    assert.equal(syncPage.isClosed(), true);
    assert.equal(instancePage.isClosed(), false);
    const saved = JSON.parse(await readFile(options.credentialStatePath, "utf8"));
    assert.ok(saved.cookies.some((cookie: { value: string }) => cookie.value === "sync"));
    assert.equal(saved.origins.find((origin: { origin: string }) => origin.origin === url).localStorage[0].value, "sync");
    await instance.close();
    assert.ok(JSON.parse(await readFile(options.credentialStatePath, "utf8")).cookies.some((cookie: { value: string }) => cookie.value === "sync"), "final close must retain the login snapshot");
    const reopened = await openKuaishouBrowserContext(path.join(root, "profile"), options);
    contexts.push(reopened);
    const page = reopened.pages()[0] ?? await reopened.newPage();
    await page.goto(url);
    assert.ok((await reopened.cookies()).some(cookie => cookie.name === "login" && cookie.value === "sync"), `session cookies survive a complete browser restart: ${JSON.stringify(await reopened.cookies())}`);
    assert.equal(await page.evaluate(() => localStorage.getItem("login")), "sync");
    await reopened.close();
    const migrated = await openKuaishouBrowserContext(path.join(root, "migrated-profile"), options);
    contexts.push(migrated);
    const migratedPage = migrated.pages()[0] ?? await migrated.newPage();
    await migratedPage.goto(url);
    assert.ok((await migrated.cookies()).some(cookie => cookie.name === "login" && cookie.value === "sync"), "older snapshot-only accounts can migrate into a persistent profile");
    assert.equal(await migratedPage.evaluate(() => localStorage.getItem("login")), "sync");
    await migratedPage.evaluate(() => { document.cookie = "login=new-login; path=/"; localStorage.setItem("login", "new-login"); });
    await migratedPage.reload();
    let autoSaved = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !autoSaved) {
      const value = JSON.parse(await readFile(options.credentialStatePath, "utf8"));
      autoSaved = value.cookies.some((cookie: { value: string }) => cookie.value === "new-login");
      if (!autoSaved) await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(autoSaved, "login changes are saved while the browser remains open");
    const other = await openKuaishouBrowserContext(path.join(root, "other-profile"), { headless: true, channel: "chromium", credentialStatePath: path.join(root, "other.json") });
    contexts.push(other);
    assert.equal((await other.cookies()).length, 0, "different source accounts stay isolated");
    await migrated.close();
    assert.equal(other.browser()?.isConnected(), true);
  } finally {
    await Promise.all(contexts.map(context => context.close().catch(() => undefined)));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
