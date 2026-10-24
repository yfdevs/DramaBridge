import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { formatAutomationErrorReport } from "@dramabridge/automation-logging";
import { fillTaobaoEpisodeContentTags, selectTaobaoContentTag } from "../../src/automation/episodes.js";
import { classifyTaobaoDramaFailStage } from "../../src/app/runtime.js";
import { reportTaobaoAccountTaskApi } from "../../src/api/task.js";

const browserCacheDir = path.resolve(import.meta.dirname, "../../../../.cache/playwright-browsers");
const cachedChromium = (await readdir(browserCacheDir))
  .filter((name) => /^chromium-\d+$/.test(name))
  .sort((left, right) => Number(right.split("-")[1]) - Number(left.split("-")[1]))[0];
assert.ok(cachedChromium, "未找到仓库共享的 Chromium 测试浏览器");
const { chromium } = await import("playwright");
const browser = await chromium.launch({
  executablePath: path.join(browserCacheDir, cachedChromium, "chrome-win64/chrome.exe"), headless: true,
});
after(async () => { await browser.close(); });

const tag = "我救了婚宴，却被罚八万";

async function tagEditor(t: TestContext, config: {
  panelOpen?: boolean;
  handlePaste?: boolean;
  createNew?: boolean;
  candidates?: string[];
  initialTags?: string[];
  topicCandidates?: string[];
  createNewTopics?: boolean;
  delayedPanel?: boolean;
  ignoreTypedSearch?: boolean;
  delayedRecommendations?: boolean;
} = {}) {
  const page = await browser.newPage();
  t.after(async () => { await page.close(); });
  let now = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(page, "waitForTimeout", async (ms: number) => {
    now += ms;
    await new Promise((resolve) => setTimeout(resolve, 1));
  });
  const html = `
    <div id="root-container"><div class="richText-container"><div id="editor" contenteditable="true" data-cangjie-content="true"></div></div></div>
    <div id="panel" class="richText-search-modal hashTag-searchPanel" style="display:none;min-height:20px;min-width:300px"></div>
    <script>
      const config = ${JSON.stringify({ panelOpen: true, handlePaste: true, createNew: false, candidates: [tag], initialTags: ["AI短剧"], topicCandidates: ["AI短剧", "都市"], createNewTopics: false, ...config })};
      const expected = ${JSON.stringify(tag)};
      const editor = document.querySelector('#editor');
      const panel = document.querySelector('#panel');
      for (const label of config.initialTags) {
        const chip = document.createElement('span');
        chip.setAttribute('data-cangjie-void', 'true');
        chip.contentEditable = 'false';
        chip.textContent = '#' + label;
        editor.append(chip, document.createTextNode(' '));
      }
      window.searches = 0;
      window.queries = [];
      window.pastes = [];
      window.pasteTrust = [];
      window.insertions = [];
      window.deletions = 0;
      window.delimiterKeys = 0;
      window.created = [];
      window.topicQueries = [];
      window.panelReady = !config.delayedPanel;
      window.earlyPastes = 0;
      window.recommendationsReady = true;
      function pastedQuery(query) { return window.pastes.some(text => text.replace(/^#/, '') === query); }
      function pendingText() {
        const clone = editor.cloneNode(true);
        clone.querySelectorAll('[data-cangjie-void]').forEach(node => node.remove());
        return clone.textContent;
      }
      function showRecords(records) {
        panel.replaceChildren();
        for (const { label, create } of records) {
          const card = document.createElement('div');
          card.className = 'hashTag-card';
          if (create) {
            card.textContent = '创建话题：#' + label;
          } else {
            const description = document.createElement('span');
            description.className = 'hashTag-card-desc';
            description.textContent = '#' + label;
            card.append(description);
          }
          card.addEventListener('click', () => {
            if (create) window.created.push(label);
            for (const node of Array.from(editor.childNodes)) {
              if (node.nodeType === Node.TEXT_NODE) node.remove();
            }
            const chip = document.createElement('span');
            chip.setAttribute('data-cangjie-void', 'true');
            chip.contentEditable = 'false';
            chip.textContent = '#' + label;
            editor.append(chip, document.createTextNode(' '));
            panel.style.display = 'none';
          });
          panel.append(card);
        }
      }
      editor.addEventListener('input', event => {
        window.insertions.push(event.data);
        if (event.inputType.startsWith('delete')) window.deletions++;
        if (event.inputType === 'insertText' && event.data?.startsWith('#')) window.searches++;
        const pending = pendingText();
        if (!pending.includes('#') || !config.panelOpen) {
          panel.style.display = 'none';
          return;
        }
        if (config.delayedPanel && event.data === '#') {
          window.panelReady = false;
          panel.style.display = 'none';
          setTimeout(() => {
            window.panelReady = true;
            panel.style.display = 'block';
          }, 5);
          return;
        }
        panel.style.display = 'block';
        if (config.delayedRecommendations && event.data === '#') {
          window.recommendationsReady = false;
          // Tab initialization starts another recommendation request after the
          // panel is visible. Its late response can replace valid search results.
          fetch('/h5/?api=mtop.taobao.media.guang.hashtag.listTabsAndRedRead')
            .then(response => response.text())
            .then(() => fetch('/h5/?api=mtop.taobao.media.guang.publish.comprehension'))
            .then(response => response.text())
            .then(() => {
              window.recommendationsReady = true;
              showRecords([{ label: '默认推荐', create: false }]);
            });
          return;
        }
        if (!window.panelReady) {
          showRecords([{ label: '默认推荐', create: false }]);
          return;
        }
        if (pending.trimEnd().endsWith('#' + expected)) {
          window.queries.push(pending.trim());
          const records = config.candidates.map(label => ({ label, create: false }));
          if (config.createNew && !config.candidates.includes(expected)) records.push({ label: expected, create: true });
          showRecords(records);
        } else if (pastedQuery(pending.slice(pending.lastIndexOf('#') + 1).trim())) {
          const query = pending.slice(pending.lastIndexOf('#') + 1).trim();
          const records = config.topicCandidates.map(label => ({ label, create: false }));
          if (config.createNewTopics && !config.topicCandidates.includes(query)) records.push({ label: query, create: true });
          showRecords(records);
        } else {
          // Reproduce a stale/default recommendation panel before native paste.
          showRecords(['职场', '收纳', '读书', '情感', '人际交往', '家居生活', '婚姻', '莫言']
            .map(label => ({ label, create: false })));
        }
      });
      editor.addEventListener('keyup', () => {
        if (config.ignoreTypedSearch) return;
        const pending = pendingText();
        if (!pending.includes('#')) return;
        const query = pending.slice(pending.lastIndexOf('#') + 1).trim();
        if (pastedQuery(query)) return;
        if (!['AI短剧', '都市'].includes(query)) return;
        window.topicQueries.push(query);
        showRecords([{ label: query, create: false }]);
      });
      editor.addEventListener('paste', event => {
        const text = event.clipboardData.getData('text/plain');
        if (!window.recommendationsReady) window.earlyPastes++;
        window.pastes.push(text);
        window.pasteTrust.push(event.isTrusted);
        if (config.handlePaste) {
          event.preventDefault();
          document.execCommand('insertText', false, text);
        }
      });
      editor.addEventListener('keydown', event => {
        if (event.key === ',' || event.key === '，') {
          window.delimiterKeys++;
          panel.style.display = 'none';
          event.preventDefault();
        }
      });
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape') panel.style.display = 'none';
      });
    </script>
  `;
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).searchParams.has("api")) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await route.fulfill({ contentType: "application/json", body: "{}" });
    } else {
      await route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
    }
  });
  await page.goto("https://creator.guanghe.taobao.com/tag-test");
  return { page, editor: page.locator("#editor") };
}

async function searchState(page: Page) {
  return page.evaluate(() => {
    const state = window as Window & {
      searches?: number; queries?: string[]; pastes?: string[]; insertions?: Array<string | null>;
      deletions?: number; delimiterKeys?: number; created?: string[]; topicQueries?: string[];
      pasteTrust?: boolean[];
    };
    return {
      searches: state.searches,
      queries: state.queries,
      pastes: state.pastes,
      pasteTrust: state.pasteTrust,
      insertions: state.insertions,
      deletions: state.deletions,
      delimiterKeys: state.delimiterKeys,
      created: state.created,
      topicQueries: state.topicQueries,
      selected: Array.from(document.querySelectorAll("[data-cangjie-void='true']")).map((node) => node.textContent),
      text: document.querySelector("#editor")?.textContent,
    };
  });
}

test("pastes all three complete tags and selects only matching records", async (t) => {
  const { page } = await tagEditor(t, { initialTags: [], candidates: [], createNew: true });
  assert.equal(await fillTaobaoEpisodeContentTags(page, tag, "都市"), 3);
  const state = await searchState(page);
  assert.equal(state.searches, 3);
  assert.deepEqual(state.topicQueries, []);
  assert.deepEqual(state.pastes, ["AI短剧", "都市", tag]);
  assert.deepEqual(state.pasteTrust, [true, true, true]);
  assert.deepEqual(state.selected, ["#AI短剧", "#都市", `#${tag}`]);
  assert.deepEqual(state.created, [tag]);
  assert.equal(state.delimiterKeys, 0);
});

test("the fixed AI短剧 tag works when typed-key search remains on default recommendations", async (t) => {
  const { page } = await tagEditor(t, { initialTags: [], candidates: [], createNew: true, ignoreTypedSearch: true });
  await fillTaobaoEpisodeContentTags(page, tag, "都市");
  const state = await searchState(page);
  assert.deepEqual(state.selected, ["#AI短剧", "#都市", `#${tag}`]);
  assert.deepEqual(state.pastes, ["AI短剧", "都市", tag]);
  assert.deepEqual(state.topicQueries, []);
});

test("the fixed first tag never accepts a similar AI tag or an unrelated default recommendation", async (t) => {
  const { page } = await tagEditor(t, { initialTags: [], topicCandidates: ["动漫解说", "AI仿真人短剧", "搞笑"], ignoreTypedSearch: true });
  await assert.rejects(fillTaobaoEpisodeContentTags(page, tag, "都市"), /目标标签“#AI短剧”/);
  const state = await searchState(page);
  assert.deepEqual(state.selected, []);
  assert.deepEqual(state.pastes, ["AI短剧"]);
  assert.equal(state.deletions, 0);
});

test("waits for the search panel to initialize before pasting each of the three tags", async (t) => {
  const { page } = await tagEditor(t, { initialTags: [], candidates: [], createNew: true, delayedPanel: true });
  await fillTaobaoEpisodeContentTags(page, tag, "都市");
  const state = await searchState(page);
  assert.deepEqual(state.selected, ["#AI短剧", "#都市", `#${tag}`]);
  assert.deepEqual(state.pastes, ["AI短剧", "都市", tag]);
  assert.equal(state.deletions, 0);
});

test("drains late default recommendations before searching, including after switching videos", async (t) => {
  const { page } = await tagEditor(t, { initialTags: [], candidates: [], createNew: true, delayedRecommendations: true });
  for (let video = 0; video < 2; video += 1) {
    await fillTaobaoEpisodeContentTags(page, tag, "都市");
    assert.deepEqual((await searchState(page)).selected, ["#AI短剧", "#都市", `#${tag}`]);
  }
  assert.equal(await page.evaluate(() => (window as Window & { earlyPastes?: number }).earlyPastes), 0);
  assert.deepEqual((await searchState(page)).pastes, ["AI短剧", "都市", tag, "AI短剧", "都市", tag]);
});

test("the second tag pastes punctuation as one query and selects the complete matching record", async (t) => {
  const genre = "都市，逆袭";
  const { page, editor } = await tagEditor(t, { topicCandidates: [genre] });
  await selectTaobaoContentTag(page, editor, genre, true, "genre");
  const state = await searchState(page);
  assert.deepEqual(state.selected, ["#AI短剧", `#${genre}`]);
  assert.deepEqual(state.pastes, [genre]);
  assert.equal(state.delimiterKeys, 0);
  assert.equal(state.deletions, 0);
});

test("the second tag clicks the new-topic record if no exact existing record is available", async (t) => {
  const { page, editor } = await tagEditor(t, { topicCandidates: [], createNewTopics: true });
  await selectTaobaoContentTag(page, editor, "重生逆袭", true, "genre");
  const state = await searchState(page);
  assert.deepEqual(state.created, ["重生逆袭"]);
  assert.deepEqual(state.pastes, ["重生逆袭"]);
  assert.deepEqual(state.selected, ["#AI短剧", "#重生逆袭"]);
});

test("the second tag preserves its pasted query instead of accepting a merely similar record", async (t) => {
  const { page, editor } = await tagEditor(t, { topicCandidates: ["都市生活"] });
  await assert.rejects(selectTaobaoContentTag(page, editor, "都市", true, "genre"), /未显示完全匹配的已有或新建标签/);
  const state = await searchState(page);
  assert.deepEqual(state.pastes, ["都市"]);
  assert.deepEqual(state.selected, ["#AI短剧"]);
  assert.equal(state.deletions, 0);
});

test("pastes a complete comma-containing title once and selects its matching record", async (t) => {
  const { page, editor } = await tagEditor(t);
  assert.equal(await selectTaobaoContentTag(page, editor, tag, true, "title"), `#${tag}`);
  const state = await searchState(page);
  assert.equal(state.searches, 1);
  assert.deepEqual(state.pastes, [tag]);
  assert.deepEqual(state.queries, [`#${tag}`]);
  assert.deepEqual(state.insertions?.filter((text) => text?.trim() && text !== '#'), [tag]);
  assert.equal(state.delimiterKeys, 0);
  assert.equal(state.deletions, 0);
  assert.deepEqual(state.selected, ["#AI短剧", `#${tag}`]);
});

test("Cangjie paste goes to the hidden textarea linked to the displayed document", async (t) => {
  const { page, editor } = await tagEditor(t);
  await editor.evaluate((element) => {
    const marker = document.createElement("span");
    marker.setAttribute("data-cangjie-editable", "true");
    marker.setAttribute("data-cangjie-key", "document-24");
    element.append(marker);
    const wrongInput = document.createElement("textarea");
    wrongInput.setAttribute("data-cangjie-dockey", "another-document");
    const input = document.createElement("textarea");
    input.setAttribute("data-cangjie-dockey", "document-24");
    input.addEventListener("paste", (event) => {
      event.preventDefault();
      const text = event.clipboardData!.getData("text/plain");
      input.setAttribute("data-pasted-text", text);
      element.append(document.createTextNode(text));
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertFromPaste" }));
    });
    document.body.append(wrongInput, input);
  });
  await selectTaobaoContentTag(page, editor, tag, true, "title");
  assert.equal(await page.locator('textarea[data-cangjie-dockey="document-24"]').getAttribute("data-pasted-text"), tag);
  assert.equal(await page.locator('textarea[data-cangjie-dockey="another-document"]').inputValue(), "");
  assert.deepEqual((await searchState(page)).selected, ["#AI短剧", `#${tag}`]);
});

test("clicks the new-topic record for the full title when no existing topic matches", async (t) => {
  const { page, editor } = await tagEditor(t, { candidates: [], createNew: true });
  await selectTaobaoContentTag(page, editor, tag, true, "title");
  const state = await searchState(page);
  assert.equal(state.searches, 1);
  assert.deepEqual(state.created, [tag]);
  assert.deepEqual(state.selected, ["#AI短剧", `#${tag}`]);
  assert.equal(state.deletions, 0);
});

test("native paste inserts the whole title when the editor uses the browser default action", async (t) => {
  const { page, editor } = await tagEditor(t, { handlePaste: false });
  await selectTaobaoContentTag(page, editor, tag, true, "title");
  const state = await searchState(page);
  assert.equal(state.searches, 1);
  assert.deepEqual(state.pastes, [tag]);
  assert.deepEqual(state.queries, [`#${tag}`]);
  assert.equal(state.delimiterKeys, 0);
  assert.deepEqual(state.selected, ["#AI短剧", `#${tag}`]);
});

test("missing selectable or new-topic records preserve the input and report a readable failure", async (t) => {
  const { page, editor } = await tagEditor(t, { candidates: [] });
  let failure: unknown;
  await assert.rejects(selectTaobaoContentTag(page, editor, tag, true, "title"), (error: Error) => {
    failure = error;
    assert.match(error.message, /未读到可选标签或新建标签记录/);
    return true;
  });
  const stage = classifyTaobaoDramaFailStage(failure);
  const message = formatAutomationErrorReport(failure);
  const calls: Record<string, unknown>[] = [];
  await reportTaobaoAccountTaskApi({
    apiBaseUrl: "http://backend.test",
    report: { taskId: 88, workerId: "worker-test", attemptCount: 3, success: false, failStage: stage, errorMessage: message },
    client: { async post(_path, payload) {
      calls.push(payload as Record<string, unknown>);
      return { code: 0, data: true } as never;
    } },
  });
  assert.equal(calls[0].failStage, "FILL_FORM");
  const reported = String(calls[0].errorMessage);
  assert.match(reported, /填写视频内容标签失败/);
  assert.ok(reported.includes(`#${tag}`));
  assert.match(reported, /已保留标签输入/);
  assert.match(reported, /请检查淘宝发布页的搜索或新建标签记录/);
  assert.match(reported, /TAOBAO_DRAMA_CONTENT_TAG_NOT_FOUND/);
  assert.doesNotMatch(reported, /tag=|suggestions=|重新搜索/);
  const state = await searchState(page);
  assert.equal(state.searches, 1);
  assert.equal(state.deletions, 0);
  assert.deepEqual(state.selected, ["#AI短剧"]);
  assert.ok(state.text?.includes(`#${tag}`));
});

test("a search panel that never opens preserves the full title without deletion or retyping", async (t) => {
  const { page, editor } = await tagEditor(t, { panelOpen: false });
  await assert.rejects(selectTaobaoContentTag(page, editor, tag, true, "title"), /完整剧名已粘贴，但标签搜索面板未打开/);
  const state = await searchState(page);
  assert.equal(state.searches, 1);
  assert.equal(state.deletions, 0);
  assert.deepEqual(state.pastes, [tag]);
  assert.ok(state.text?.includes(`#${tag}`));
});

test("a partial title cannot substitute for a record matching the complete drama title", async (t) => {
  const { page, editor } = await tagEditor(t, { candidates: ["我救了婚宴"] });
  await assert.rejects(selectTaobaoContentTag(page, editor, tag, true, "title"), (error: Error) => {
    assert.match(error.message, /未显示完全匹配的已有或新建标签/);
    assert.match(error.message, /候选标签：#我救了婚宴/);
    return true;
  });
  const state = await searchState(page);
  assert.equal(state.searches, 1);
  assert.equal(state.deletions, 0);
  assert.deepEqual(state.selected, ["#AI短剧"]);
});

