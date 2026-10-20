# AGENTS.md

## Project Shape

This repository is a multi-platform desktop automation app. The current implemented platform is WeChat Video Channel only. Future platforms, such as Kuaishou drama, must be added as separate platform modules instead of extending WeChat-specific files.

## Directory Boundaries

- `electron/main.ts` is the Electron shell only: window creation, menu setup, app lifecycle, and platform handler registration.
- `electron/platforms/<platform>.ts` owns platform-specific main-process IPC, service lifecycle, local configuration storage, and runtime bootstrapping.
- `src/pages/<platform>/` owns renderer pages for that platform.
- `src/platforms/<platform>/` owns renderer-side platform services, IPC clients, and platform-specific frontend types.
- `packages/<platform>-automation/` owns Playwright/runtime implementation for that platform.
- `components/ui/` is shared UI infrastructure only. Do not put platform logic there.

## Naming Rules

- Use platform-prefixed IPC channels, for example `wechat-drama:service:start`.
- Do not use generic names like `automation-service` for platform-specific behavior.
- Root scripts for platform automation must be platform-prefixed, for example `wechat-drama:check`.
- Package names must include the platform, for example `@dramabridge/wechat-drama-automation`.

## Configuration

- Desktop configuration persistence uses `electron-store`.
- Do not add hand-rolled JSON cache readers or writers for app configuration.
- Renderer pages must call Electron IPC through platform services under `src/platforms/<platform>/`.
- Business configuration is injected into automation runtimes from the platform main-process module. Do not read business settings from environment files or `process.env`.
- Infrastructure variables required by tooling, such as `PLAYWRIGHT_BROWSERS_PATH`, are allowed only at the platform/runtime boot boundary.

## Submission And Task Page Lifecycle

- After a platform's final submit action is clicked, keep its dedicated task page open for at least 10 seconds before closing it, even when a success signal appears immediately.
- The 10-second settle period is only a minimum safety buffer. It does not replace platform-specific success verification; close a successful task page only after both the settle period and the success check have completed.
- Failed task pages must continue to follow the platform's configured failure-page retention policy.

## Platform Expansion Checklist

When adding a new platform:

1. Add `packages/<platform>-automation/`.
2. Add `electron/platforms/<platform>.ts`.
3. Add `src/platforms/<platform>/service.ts`.
4. Add pages under `src/pages/<platform>/`.
5. Add routes and sidebar entries in `src/config/navigation.ts` and `src/routes/app-routes.tsx`.
6. Add platform-specific package scripts in `package.json`.
7. Share Playwright browser binaries through `.cache/playwright-browsers` unless a platform explicitly requires a different browser engine or version.

## Verification

Before handing off changes, run the relevant checks:

```bash
pnpm exec tsc --noEmit
pnpm --filter @dramabridge/wechat-drama-automation check
pnpm --filter @dramabridge/wechat-drama-automation build
pnpm exec vite build
```
