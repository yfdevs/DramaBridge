import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite-plus";

test("bundling a shared browser dependency does not eagerly initialize Playwright", async () => {
  const result = await build({
    configFile: false,
    logLevel: "error",
    build: {
      ssr: true,
      write: false,
      target: "node20",
      rollupOptions: {
        preserveEntrySignatures: "strict",
        input: fileURLToPath(new URL("../../packages/browser-window/src/index.ts", import.meta.url)),
        external: ["playwright"],
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => "output" in item ? item.output : []);
  const chunks = outputs.filter(item => item.type === "chunk");
  assert.ok(chunks.length > 0);
  for (const chunk of chunks) assert.ok(!chunk.imports.includes("playwright"), "shared chunk must not import Playwright before platform configuration");
  assert.ok(chunks.some(chunk => /import\(["']playwright["']\)/.test(chunk.code)), "Playwright must load on browser launch");
});
