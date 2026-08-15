import 'dotenv/config'
import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { getMcpManager } from './mcp/manager'

// 中和宿主 shell 注入的 ANTHROPIC_*（如从 Claude Code/Codex 终端启动时）：
// @anthropic-ai/sdk 在未显式传 authToken 时会兜底读 ANTHROPIC_AUTH_TOKEN，
// 随请求额外发 Authorization: Bearer <宿主 token>；GLM 的 anthropic 兼容端点
// 优先校验 Authorization 头，会用这个无关 token 判 401（key 本身有效）。
// 本应用的 provider 配置只来自自己的 .env，删除使行为确定。
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_BASE_URL

const isDev = !app.isPackaged

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'LangChain Code Agent',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && rendererUrl) {
    void win.loadURL(rendererUrl)
    win.webContents.openDevTools()
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void getMcpManager().disconnectAll()
})
