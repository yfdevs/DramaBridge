# @dramabridge/pinduoduo-drama-automation

Pinduoduo short-play automation package.

## Scope

- Runtime entry: `startPinduoduoDramaRuntime`
- Manage page: `https://mcn.pinduoduo.com/home/shortplayManage`
- Login-expired page: `https://mcn.pinduoduo.com/register`
- Task APIs: `src/api/task.ts`
- Zod schemas and public types: `src/shared/types.ts`
- Runtime logging: `src/shared/logger.ts`

Business configuration is passed through runtime or API options. The package does not read business settings from environment variables.
