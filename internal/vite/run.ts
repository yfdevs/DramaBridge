import type { UserConfig } from "vite-plus";
import { readFileSync } from "node:fs";

function packageSourceInputs(directory: string, visited = new Set<string>()): string[] {
  if (visited.has(directory)) return [];
  visited.add(directory);
  const manifest = JSON.parse(
    readFileSync(new URL(`../../packages/${directory}/package.json`, import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const dependencies = Object.keys(manifest.dependencies ?? {})
    .filter((name) => name.startsWith("@dramabridge/"))
    .flatMap((name) => packageSourceInputs(name.slice("@dramabridge/".length), visited));
  return [
    ...["src/**", "scripts/**", "native/**", "*.json", "*.ts", "*.mts"].map(
      (pattern) => `packages/${directory}/${pattern}`,
    ),
    ...dependencies,
  ];
}

// These tasks belong to the workspace root. `cwd` changes where commands run,
// not the base of input globs. Include transitive workspace sources as well:
// declaration generation reads their source types even without a package build.
const packageBuildInputs = (directory: string) => [
  ...packageSourceInputs(directory),
  "package.json",
  { pattern: "pnpm-lock.yaml", base: "workspace" as const },
  { pattern: "pnpm-workspace.yaml", base: "workspace" as const },
];

const appTypecheckInputs = [
  "components/**",
  "electron/**",
  "src/**",
  "packages/*/src/**",
  "packages/*/package.json",
  "packages/*/tsconfig*.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig*.json",
];

const appBuildInputs = [
  ...appTypecheckInputs,
  "packages/*/scripts/**",
  "packages/*/native/**",
  "packages/*/vite.config.*",
  "public/**",
  "index.html",
  "vite.config.*",
  "internal/**",
  "postcss.config.*",
  "patches/**",
  ".env",
  ".env.*",
];

export const runConfig = {
  tasks: {
    "pkg:browser-window:build": {
      command: "vp pack",
      cwd: "packages/browser-window",
      input: packageBuildInputs("browser-window"),
      output: ["packages/browser-window/dist/**"],
    },
    "pkg:logging:build": {
      command: "vp pack",
      cwd: "packages/automation-logging",
      dependsOn: ["pkg:file-utils:build"],
      input: packageBuildInputs("automation-logging"),
      output: ["packages/automation-logging/dist/**"],
    },
    "pkg:file-utils:build": {
      command: "vp pack",
      cwd: "packages/file-utils",
      input: packageBuildInputs("file-utils"),
      output: ["packages/file-utils/dist/**"],
    },
    "pkg:axios:build": {
      command: "vp pack",
      cwd: "packages/axios",
      input: packageBuildInputs("axios"),
      output: ["packages/axios/dist/**"],
    },
    "pkg:ai:build": {
      command: "vp pack",
      cwd: "packages/ai",
      input: packageBuildInputs("ai"),
      output: ["packages/ai/dist/**"],
    },
    "pkg:wechat:build": {
      command: "vp pack",
      cwd: "packages/wechat-drama-automation",
      dependsOn: ["pkg:browser-window:build", "pkg:axios:build", "pkg:logging:build"],
      input: packageBuildInputs("wechat-drama-automation"),
      output: ["packages/wechat-drama-automation/dist/**"],
    },
    "pkg:wechat-miniprogram:build": {
      command: "vp pack",
      cwd: "packages/wechat-miniprogram-drama-automation",
      dependsOn: ["pkg:browser-window:build", "pkg:axios:build", "pkg:logging:build"],
      input: packageBuildInputs("wechat-miniprogram-drama-automation"),
      output: ["packages/wechat-miniprogram-drama-automation/dist/**"],
    },
    "pkg:meituan:build": {
      command: "vp pack",
      cwd: "packages/meituan-drama-automation",
      dependsOn: ["pkg:browser-window:build", "pkg:logging:build"],
      input: packageBuildInputs("meituan-drama-automation"),
      output: ["packages/meituan-drama-automation/dist/**"],
    },
    "pkg:kuaishou:build": {
      command: "pnpm run build",
      cwd: "packages/kuaishou-drama-automation",
      dependsOn: ["pkg:browser-window:build", "pkg:logging:build"],
      input: packageBuildInputs("kuaishou-drama-automation"),
      output: ["packages/kuaishou-drama-automation/dist/**"],
    },
    "pkg:qq:build": {
      command: "vp pack",
      cwd: "packages/qq-drama-automation",
      dependsOn: ["pkg:browser-window:build", "pkg:logging:build"],
      input: packageBuildInputs("qq-drama-automation"),
      output: ["packages/qq-drama-automation/dist/**"],
    },
    "pkg:taobao:build": {
      command: "vp pack",
      cwd: "packages/taobao-drama-automation",
      dependsOn: ["pkg:browser-window:build", "pkg:ai:build", "pkg:logging:build"],
      input: packageBuildInputs("taobao-drama-automation"),
      output: ["packages/taobao-drama-automation/dist/**"],
    },
    "pkg:tencent-huolong:build": {
      command: "vp pack",
      cwd: "packages/tencent-huolong-drama-automation",
      dependsOn: ["pkg:browser-window:build", "pkg:ai:build", "pkg:logging:build"],
      input: packageBuildInputs("tencent-huolong-drama-automation"),
      output: ["packages/tencent-huolong-drama-automation/dist/**"],
    },
    "pkg:iqiyi:build": {
      command: "vp pack",
      cwd: "packages/iqiyi-drama-automation",
      dependsOn: ["pkg:browser-window:build", "pkg:logging:build"],
      input: packageBuildInputs("iqiyi-drama-automation"),
      output: ["packages/iqiyi-drama-automation/dist/**"],
    },
    "pkg:baidu-drama:build": {
      command: "vp pack",
      cwd: "packages/baidu-drama-automation",
      dependsOn: ["pkg:browser-window:build", "pkg:logging:build"],
      input: packageBuildInputs("baidu-drama-automation"),
      output: ["packages/baidu-drama-automation/dist/**"],
    },
    "pkg:pinduoduo:build": {
      command: "vp pack",
      cwd: "packages/pinduoduo-drama-automation",
      dependsOn: ["pkg:browser-window:build", "pkg:axios:build", "pkg:logging:build"],
      input: packageBuildInputs("pinduoduo-drama-automation"),
      output: ["packages/pinduoduo-drama-automation/dist/**"],
    },
    "pkg:tiktok:build": {
      command: "vp pack",
      cwd: "packages/tiktok-drama-automation",
      dependsOn: ["pkg:browser-window:build", "pkg:logging:build"],
      input: packageBuildInputs("tiktok-drama-automation"),
      output: ["packages/tiktok-drama-automation/dist/**"],
    },
    "pkg:douyin:build": {
      command: "vp pack",
      cwd: "packages/douyin-drama-automation",
      dependsOn: ["pkg:browser-window:build", "pkg:logging:build"],
      input: packageBuildInputs("douyin-drama-automation"),
      output: ["packages/douyin-drama-automation/dist/**"],
    },
    "pkg:baidu:build": {
      command: "vp pack",
      cwd: "packages/baidu-netdisk-automation",
      dependsOn: ["pkg:logging:build"],
      input: packageBuildInputs("baidu-netdisk-automation"),
      output: ["packages/baidu-netdisk-automation/dist/**"],
    },
    "packages:build": {
      command: "node -e \"console.log('workspace packages built')\"",
      dependsOn: [
        "pkg:ai:build",
        "pkg:file-utils:build",
        "pkg:logging:build",
        "pkg:wechat:build",
        "pkg:wechat-miniprogram:build",
        "pkg:meituan:build",
        "pkg:kuaishou:build",
        "pkg:qq:build",
        "pkg:taobao:build",
        "pkg:tencent-huolong:build",
        "pkg:iqiyi:build",
        "pkg:baidu-drama:build",
        "pkg:pinduoduo:build",
        "pkg:tiktok:build",
        "pkg:douyin:build",
        "pkg:baidu:build",
      ],
      output: [],
    },
    "pkg:wechat:check": {
      command: "tsc --noEmit",
      cwd: "packages/wechat-drama-automation",
      output: [],
    },
    "pkg:wechat-miniprogram:check": {
      command: "tsc --noEmit",
      cwd: "packages/wechat-miniprogram-drama-automation",
      output: [],
    },
    "pkg:logging:check": {
      command: "tsc --noEmit",
      cwd: "packages/automation-logging",
      output: [],
    },
    "pkg:file-utils:check": {
      command: "tsc --noEmit",
      cwd: "packages/file-utils",
      output: [],
    },
    "pkg:ai:check": {
      command: "tsc --noEmit",
      cwd: "packages/ai",
      output: [],
    },
    "pkg:meituan:check": {
      command: "tsc --noEmit",
      cwd: "packages/meituan-drama-automation",
      output: [],
    },
    "pkg:kuaishou:check": {
      command: "tsc --noEmit",
      cwd: "packages/kuaishou-drama-automation",
      output: [],
    },
    "pkg:pinduoduo:check": {
      command: "tsc --noEmit",
      cwd: "packages/pinduoduo-drama-automation",
      output: [],
    },
    "pkg:tiktok:check": {
      command: "tsc --noEmit",
      cwd: "packages/tiktok-drama-automation",
      output: [],
    },
    "pkg:douyin:check": {
      command: "tsc --noEmit",
      cwd: "packages/douyin-drama-automation",
      output: [],
    },
    "pkg:baidu:check": {
      command: "tsc --noEmit",
      cwd: "packages/baidu-netdisk-automation",
      output: [],
    },
    "pkg:jianying:check": {
      command: "tsc --noEmit",
      cwd: "packages/jianying-automation",
      output: [],
    },
    "pkg:qq:check": {
      command: "tsc --noEmit",
      cwd: "packages/qq-drama-automation",
      output: [],
    },
    "pkg:taobao:check": {
      command: "tsc --noEmit",
      cwd: "packages/taobao-drama-automation",
      output: [],
    },
    "pkg:tencent-huolong:check": {
      command: "tsc --noEmit",
      cwd: "packages/tencent-huolong-drama-automation",
      output: [],
    },
    "pkg:iqiyi:check": {
      command: "tsc --noEmit",
      cwd: "packages/iqiyi-drama-automation",
      output: [],
    },
    "pkg:baidu-drama:check": {
      command: "tsc --noEmit",
      cwd: "packages/baidu-drama-automation",
      output: [],
    },
    "app:typecheck": {
      command: "tsc --noEmit",
      input: appTypecheckInputs,
      output: [],
    },
    "playwright:browsers": {
      command: "node scripts/install-playwright-browsers.mjs",
      cache: false,
    },
    "app:build": {
      command: "vp build",
      dependsOn: ["packages:build", "playwright:browsers", "app:typecheck"],
      input: appBuildInputs,
      output: ["dist/**", "dist-electron/**"],
    },
  },
} satisfies UserConfig["run"];
