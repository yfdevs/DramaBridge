import path from 'node:path';
import {
  createAutomationLogger,
  formatDateKey,
  type AutomationLogEntry,
  type AutomationLogger,
} from '@dramabridge/automation-logging';
import { z } from 'zod';

const configSchema = z.object({
  logFile: z.string().min(1).default(path.resolve(`logs/app-${formatDateKey()}.log`)),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  loginUrl: z.string().url().default('https://www.tiktokdramacenter.com/login'),
  draftUrl: z.string().url().default('https://www.tiktokdramacenter.com/series/draft'),
  feishuBotWebhookUrl: z.string().trim().default(''),
  userDataDir: z.string().min(1).default(path.resolve('.auth/tiktok')),
  videoDir: z.string().min(1).default(path.resolve('videos')),
  schemeApi: z.string().url().optional(),
  schemeFile: z.string().min(1).default('scheme.local.json'),
  tempDir: z.string().min(1).default(path.resolve('.tmp')),
  postTaskWatchMs: z.number().nonnegative().default(5_000),
  submit: z.boolean().default(false),
  keepBrowserOpen: z.boolean().default(true),
  headless: z.boolean().default(false)
});

export type TiktokDramaCenterRuntimeSettings = z.input<typeof configSchema>;
export type TiktokDramaCenterConfig = z.infer<typeof configSchema>;
export let config: TiktokDramaCenterConfig = configSchema.parse({});
export let logger: AutomationLogger = createLogger(config);

export function configureTiktokDramaCenterRuntimeSettings(
  settings: Partial<TiktokDramaCenterRuntimeSettings> = {},
  onEntry?: (entry: AutomationLogEntry) => void,
) {
  config = configSchema.parse(settings);
  logger = createLogger(config, onEntry);
  return config;
}

function createLogger(
  nextConfig: TiktokDramaCenterConfig,
  onEntry?: (entry: AutomationLogEntry) => void,
) {
  return createAutomationLogger({
    platform: 'tiktok-drama',
    scope: 'runtime',
    logFilePath: nextConfig.logFile,
    onEntry,
    console: true,
  });
}
