import { ipcRenderer, contextBridge } from 'electron'
import { createTRPCProxyClient } from '@trpc/client'
import { Titlebar, TitlebarColor } from 'custom-electron-titlebar'
import { ipcLink } from 'electron-trpc/renderer'

import type { ElectronIpcRouter } from './ipc/router'

type IpcRendererListener = Parameters<typeof ipcRenderer.on>[1]
type TrpcSubscription = { unsubscribe: () => void }

const listenerMap = new Map<string, WeakMap<IpcRendererListener, TrpcSubscription>>()
const electronTrpcBridge = {
  sendMessage: (operation: unknown) => ipcRenderer.send('electron-trpc', operation),
  onMessage: (callback: (response: unknown) => void) =>
    ipcRenderer.on('electron-trpc', (_event, response) => callback(response)),
}

Object.defineProperty(globalThis, 'electronTRPC', {
  configurable: false,
  enumerable: false,
  value: electronTrpcBridge,
  writable: false,
})

const trpcClient = createTRPCProxyClient<ElectronIpcRouter>({
  links: [ipcLink()],
})
const nativeTitlebarWindowModes = new Set([
  'wechat-miniprogram-baidu-upload',
  'wechat-miniprogram-catalog-upload',
  'pinduoduo-drama-upload-records',
])

function rendererPlatformClass(platform: NodeJS.Platform) {
  switch (platform) {
    case 'darwin':
      return 'platform-mac'
    case 'win32':
      return 'platform-win'
    case 'linux':
      return 'platform-linux'
    default:
      return 'platform-other'
  }
}

function getListenerMap(channel: string) {
  let channelListeners = listenerMap.get(channel)

  if (!channelListeners) {
    channelListeners = new WeakMap<IpcRendererListener, TrpcSubscription>()
    listenerMap.set(channel, channelListeners)
  }

  return channelListeners
}

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('ipcRenderer', {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args
    const channelListeners = getListenerMap(channel)
    channelListeners.get(listener)?.unsubscribe()
    const subscription = trpcClient.events.subscribe(
      { channel },
      {
        onData: (eventArgs) => listener(undefined as never, ...eventArgs),
      },
    )
    channelListeners.set(listener, subscription)
    return undefined
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, listener] = args
    const channelListeners = getListenerMap(channel)
    channelListeners.get(listener)?.unsubscribe()
    channelListeners.delete(listener)
    return undefined
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args
    void trpcClient.invoke.mutate({ channel, args: omit })
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args
    return trpcClient.invoke.mutate({ channel, args: omit })
  },

  // You can expose other APTs you need here.
  // ...
})

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add(rendererPlatformClass(process.platform))

  const windowMode = new URLSearchParams(window.location.search).get('window')
  if (windowMode && nativeTitlebarWindowModes.has(windowMode)) return

  const titlebar = new Titlebar({
    backgroundColor: TitlebarColor.fromHex('#ffffff'),
    itemBackgroundColor: TitlebarColor.fromHex('#f3f4f6'),
    menuBarBackgroundColor: TitlebarColor.fromHex('#ffffff'),
    menuSeparatorColor: TitlebarColor.fromHex('#e5e5e5'),
    svgColor: TitlebarColor.fromHex('#404040'),
    icon: './icon.png',
    iconSize: 18,
    shadow: false,
    titleHorizontalAlignment: 'left',
    unfocusEffect: false,
    containerOverflow: 'hidden',
    tooltips: {
      minimize: '最小化',
      maximize: '最大化',
      restoreDown: '还原',
      close: '关闭',
    },
  })

  titlebar.updateTitle('DramaBridge')
})
