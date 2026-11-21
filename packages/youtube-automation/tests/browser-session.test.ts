import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  YoutubeBrowserSessions,
  studioChannelId,
  youtubeVideoEditUrl,
  type YoutubeBrowserCredential,
} from "../src/browser-session.js";
import { applyYoutubeBrowserRights } from "../src/browser-rights.js";

const channel = "UC" + "a".repeat(22);
const dashboard = `https://studio.youtube.com/channel/${channel}`;

test("ordinary video settings cannot be mistaken for Content ID controls or saved partially", async () => {
  let saves = 0;
  const missing = {
    or() {
      return this;
    },
    filter() {
      return this;
    },
    count: async () => 0,
  };
  const page = {
    url: () => youtubeVideoEditUrl("abcdefghijk"),
    getByRole: (_role: string, options: { name: RegExp }) => {
      if (options.name.test("保存"))
        return {
          waitFor: async () => {},
          click: async () => {
            saves++;
          },
        };
      if (options.name.test("显示高级设置"))
        return { isVisible: async () => true, click: async () => {} };
      return missing;
    },
  };
  await assert.rejects(
    applyYoutubeBrowserRights(page as never, async () => {}),
    /上传政策.*全球获利/,
  );
  assert.equal(saves, 0);
  await assert.rejects(
    applyYoutubeBrowserRights(
      { url: () => "https://evil.example/video/abcdefghijk/edit" } as never,
      async () => {},
    ),
    /未进入指定视频/,
  );
});

test("browser credentials accept only platform-owned account/channel/video identifiers", () => {
  assert.equal(studioChannelId(dashboard), channel);
  assert.equal(studioChannelId(`https://evil.example/channel/${channel}`), undefined);
  assert.equal(
    youtubeVideoEditUrl("abcdefghijk"),
    "https://studio.youtube.com/video/abcdefghijk/edit",
  );
  assert.throws(() => youtubeVideoEditUrl("../accounts"));
});

function fixture(directory: string) {
  const credentials = new Map<string, YoutubeBrowserCredential>();
  const launches: string[] = [];
  const pages: {
    current: string;
    closed: boolean;
    goto: (url: string) => Promise<void>;
    url: () => string;
    isClosed: () => boolean;
  }[] = [];
  let redirect: string | undefined;
  let navigationGate: Promise<void> | undefined;
  let proxy = "";
  const manager = new YoutubeBrowserSessions(() => ({
    directory,
    proxy,
    all: () => Object.fromEntries(credentials),
    read: (id) => credentials.get(id),
    write: (id, value) => {
      if (value) credentials.set(id, value);
      else credentials.delete(id);
    },
    launch: (async (profile: string, options: { headless: boolean; channel: string }) => {
      assert.equal(options.channel, "chrome");
      assert.equal(options.headless, false);
      launches.push(profile);
      const localPages: typeof pages = [];
      const makePage = () => {
        const page = {
          current: "about:blank",
          closed: false,
          goto: async (url: string) => {
            await navigationGate;
            page.current = redirect ?? url;
          },
          url: () => page.current,
          isClosed: () => page.closed,
          waitForURL: async () => {},
          bringToFront: async () => {},
          close: async () => {
            page.closed = true;
          },
          locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
        };
        pages.push(page);
        localPages.push(page);
        return page;
      };
      makePage();
      const listeners: (() => void)[] = [];
      return {
        pages: () => localPages.filter((page) => !page.closed),
        newPage: async () => makePage(),
        on: (_event: string, callback: () => void) => listeners.push(callback),
        close: async () => {
          localPages.forEach((page) => {
            page.closed = true;
          });
          listeners.forEach((listener) => listener());
        },
        addCookies: () => {
          throw new Error("Cookie injection must never be used");
        },
      };
    }) as never,
  }));
  return {
    manager,
    credentials,
    launches,
    pages,
    setProxy: (value: string) => {
      proxy = value;
    },
    redirect: (value?: string) => {
      redirect = value;
    },
    gate: (value?: Promise<void>) => {
      navigationGate = value;
    },
  };
}

test("manual login requires Studio confirmation, persists and rejects migrated cookies and changed proxy", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "youtube-browser-"));
  const f = fixture(directory);
  try {
    await assert.rejects(f.manager.check("default"), /浏览器登录/);
    await f.manager.start("default");
    await assert.rejects(f.manager.save("default"), /目标频道|登录/);
    assert.equal(f.credentials.size, 0);
    f.pages[0]!.current = dashboard;
    await f.manager.save("default");
    assert.equal(f.credentials.get("default")?.source, "browser");
    await f.manager.check("default");
    await f.manager.close();
    await f.manager.check("default");
    assert.equal(f.launches[0], f.launches[1]);
    f.setProxy("http://127.0.0.1:7890");
    await assert.rejects(f.manager.check("default"), /代理设置已改变/);
    assert.equal(f.launches.length, 2);
    f.setProxy("");
    f.redirect("https://accounts.google.com/signin");
    await assert.rejects(f.manager.check("default"), /登录已失效/);
    assert.equal(f.manager.status("default").needsLogin, true);
    f.redirect(`https://studio.youtube.com/channel/UC${"z".repeat(22)}`);
    await assert.rejects(f.manager.check("default"), /未能进入已绑定频道/);
    f.credentials.set("a".repeat(32), { channelId: channel, savedAt: "old", source: "cookies" });
    assert.equal(f.manager.status("a".repeat(32)).saved, false);
    await assert.rejects(f.manager.start("a".repeat(32)), /旧 Cookie/);
    await assert.rejects(f.manager.check("../escape"), /无效/);
  } finally {
    await f.manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("channels reuse one Google browser and lock by profile; deleting a binding preserves other channels", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "youtube-shared-"));
  const f = fixture(directory);
  const second = "b".repeat(32),
    secondChannel = "UC" + "b".repeat(22);
  try {
    await f.manager.start("default");
    f.pages[0]!.current = dashboard;
    await f.manager.save("default");
    await f.manager.start(second, "default");
    await assert.rejects(f.manager.check("default"), /完成或取消/);
    f.pages[0]!.current = `https://studio.youtube.com/channel/${secondChannel}`;
    await f.manager.save(second);
    assert.equal(f.launches.length, 1);
    assert.equal(f.manager.status(second).profileId, "default");
    assert.equal(f.manager.status(second).channelId, secondChannel);
    let release!: () => void;
    f.gate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const check = f.manager.check("default");
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(f.manager.status(second).busy, true);
    await assert.rejects(f.manager.start(second), /正在执行/);
    release();
    await check;
    f.gate();
    await f.manager.check(second);
    assert.equal(f.pages[0]!.current, `https://studio.youtube.com/channel/${secondChannel}`);
    await f.manager.forget("default");
    assert.equal(f.pages[0]!.closed, false);
    await f.manager.check(second);
    await f.manager.forget(second);
    assert.equal(f.pages[0]!.closed, true);
  } finally {
    await f.manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("proxy changes during login cannot be saved, and cancellation does not bind credentials", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "youtube-login-cancel-"));
  const f = fixture(directory);
  try {
    await f.manager.start("default");
    f.pages[0]!.current = dashboard;
    f.setProxy("http://127.0.0.1:1234");
    await assert.rejects(f.manager.save("default"), /代理设置已改变/);
    assert.equal(f.credentials.size, 0);
    await f.manager.cancel("default");
    assert.equal(f.pages[0]!.closed, true);
    assert.equal(f.credentials.size, 0);
  } finally {
    await f.manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("shared browser tasks queue and cancelled waiting tasks never open or edit videos", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "youtube-task-queue-"));
  const f = fixture(directory);
  try {
    await f.manager.start("default");
    f.pages[0]!.current = dashboard;
    await f.manager.save("default");
    let release!: () => void;
    let started!: () => void;
    const inEdit = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    const first = f.manager.withVideo(
      "default",
      "abcdefghijk",
      async () => {},
      async () => {
        events.push("first");
        started();
        await hold;
      },
    );
    await inEdit;
    let active = true;
    const cancelled = f.manager.withVideo(
      "default",
      "abcdefghijl",
      async () => {
        if (!active) throw new Error("task cancelled");
      },
      async () => {
        events.push("cancelled");
      },
    );
    const cancelledResult = assert.rejects(cancelled, /task cancelled/);
    const second = f.manager.withVideo(
      "default",
      "abcdefghijm",
      async () => {},
      async () => {
        events.push("second");
      },
    );
    active = false;
    assert.deepEqual(events, ["first"]);
    release();
    await Promise.all([first, second, cancelledResult]);
    assert.deepEqual(events, ["first", "second"]);
    assert.equal(
      f.pages.some((page) => page.current.includes("abcdefghijl")),
      false,
    );
  } finally {
    await f.manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
