import { app, BrowserWindow, dialog, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron'
import path from 'node:path'
import { fsSize, mem } from 'systeminformation'
import { createAsyncCache } from '../../core/async-cache'

export { RuntimeController } from './runtime-controller'
export { ensureDirectories, findLatestFile, openExistingPath, openPathOrParent } from './storage'
export { numberText } from './config'

export type PlatformMemoryStatus = {
  processRssBytes: number
  systemUsedBytes: number
  systemTotalBytes: number
  systemUsedPercent: number
}

export type PlatformDriveStatus = {
  mount: string
  usedBytes: number
  totalBytes: number
  availableBytes: number
  usedPercent: number
}

const readCachedMemory = createAsyncCache(() => mem(), 5_000)
const readCachedDriveList = createAsyncCache(() => fsSize(), 10_000)

export async function readMemoryStatus(processRssBytes = process.memoryUsage().rss): Promise<PlatformMemoryStatus> {
  const memory = await readCachedMemory()
  const systemUsedBytes = memory.total - memory.available

  return {
    processRssBytes,
    systemUsedBytes,
    systemTotalBytes: memory.total,
    systemUsedPercent: memory.total > 0 ? (systemUsedBytes / memory.total) * 100 : 0,
  }
}

export async function readDriveStatus(targetMount = 'D:'): Promise<PlatformDriveStatus | null> {
  let driveList: Awaited<ReturnType<typeof fsSize>>

  try {
    driveList = await readCachedDriveList()
  } catch {
    return null
  }

  const normalizedTargetMount = normalizeDriveMount(targetMount)
  const drive = driveList.find((item) => normalizeDriveMount(item.mount) === normalizedTargetMount)

  if (!drive) {
    return null
  }

  return {
    mount: drive.mount,
    usedBytes: drive.used,
    totalBytes: drive.size,
    availableBytes: drive.available,
    usedPercent: Number.isFinite(drive.use) ? drive.use : drive.size > 0 ? (drive.used / drive.size) * 100 : 0,
  }
}

function normalizeDriveMount(mount: string) {
  return mount.trim().replace(/[\\/]+$/, '').toUpperCase()
}

export async function selectDirectory(event: IpcMainInvokeEvent, options: OpenDialogOptions) {
  const parentWindow = BrowserWindow.fromWebContents(event.sender)
  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, options)
    : await dialog.showOpenDialog(options)

  return result.canceled ? null : result.filePaths[0] ?? null
}

export function directoryDefaultPath(currentPath: string | undefined, fallback: string) {
  const trimmedPath = currentPath?.trim()

  if (!trimmedPath) {
    return fallback
  }

  return path.isAbsolute(trimmedPath)
    ? trimmedPath
    : path.join(app.isPackaged ? path.dirname(process.execPath) : process.env.APP_ROOT, trimmedPath)
}

export function normalizePlatformRunDataDir(selectedPath: string | null, platformDirName: string) {
  if (!selectedPath) {
    return null
  }

  const normalizedPath = path.normalize(selectedPath)
  const selectedDirName = path.basename(normalizedPath).toLowerCase()
  const normalizedPlatformDirName = platformDirName.toLowerCase()

  if (selectedDirName === normalizedPlatformDirName) {
    return normalizedPath
  }

  if (selectedDirName === '.drama-runs') {
    return path.join(normalizedPath, platformDirName)
  }

  return path.join(normalizedPath, '.drama-runs', platformDirName)
}

export function resolveFromAppRoot(value: string) {
  if (path.isAbsolute(value)) {
    return value
  }

  const relativePathRoot = app.isPackaged
    ? path.dirname(process.execPath)
    : process.env.APP_ROOT
  return path.join(relativePathRoot, value)
}

export function playwrightBrowsersPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    return process.env.PLAYWRIGHT_BROWSERS_PATH
  }

  return app.isPackaged
    ? path.join(process.resourcesPath, 'playwright-browsers')
    : path.join(process.env.APP_ROOT, '.cache', 'playwright-browsers')
}

export function platformWindowIconPath(fileName: string) {
  return path.join(process.env.VITE_PUBLIC, fileName)
}

export function configureNativeChildWindow(window: BrowserWindow, title: string) {
  window.setMenu(null)
  window.setTitle(title)
  window.on('page-title-updated', (event) => {
    event.preventDefault()
    window.setTitle(title)
  })
}
