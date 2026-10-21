import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'

export function ensureDirectories(directories: Iterable<string>) {
  for (const directory of directories) {
    mkdirSync(directory, { recursive: true })
  }
}

export function findLatestFile(
  directory: string,
  matches: (fileName: string) => boolean = () => true,
) {
  mkdirSync(directory, { recursive: true })

  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && matches(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0] ?? directory
}

export async function openExistingPath(targetPath: string) {
  const errorMessage = existsSync(targetPath)
    ? await shell.openPath(targetPath)
    : `路径不存在：${targetPath}`

  if (errorMessage) {
    throw new Error(errorMessage)
  }

  return targetPath
}

export function openPathOrParent(targetPath: string) {
  return openExistingPath(existsSync(targetPath) ? targetPath : path.dirname(targetPath))
}
