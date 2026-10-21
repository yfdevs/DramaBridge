/// <reference types="vite-plugin-electron/electron-env" />

declare namespace NodeJS {
  interface ProcessEnv {
    /**
     * The built directory structure
     *
     * ```tree
     * ├─┬─┬ dist
     * │ │ └── index.html
     * │ │
     * │ ├─┬ dist-electron
     * │ │ ├── main.js
     * │ │ └── preload.js
     * │
     * ```
     */
    APP_ROOT: string
    /** /dist/ or /public/ */
    VITE_PUBLIC: string
  }
}

// Used in Renderer process, expose in `preload.ts`
interface Window {
  ipcRenderer: import('electron').IpcRenderer
  platformLogs: {
    subscribe: (
      platform: import('./platform-logs').PlatformLogId,
      observer: {
        onData: (event: import('./platform-logs').PlatformLogEvent) => void
        onError: (error: { message: string }) => void
      },
    ) => () => void
    clear: (
      platform: import('./platform-logs').PlatformLogId,
    ) => Promise<{ cleared: boolean; filePath: string | null }>
  }
}
