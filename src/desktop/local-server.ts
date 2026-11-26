/**
 * Signed-runtime local loopback HTTP/RPC server for Memloom Desktop.
 *
 * Serves the built renderer bundle exclusively on `127.0.0.1` with a
 * per-session random secret token and same-origin checks, routing authenticated
 * `POST /api/invoke` calls directly into {@link createDesktopIpcHandlers}.
 * @module memloom/desktop/local-server
 */
import { execFile } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import * as fs from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { promisify } from 'node:util'
import { isAllowedExternalUrl, type DesktopAppInfo } from './ipc-contract.ts'
import { createDesktopIpcHandlers, type DialogAdapter } from './main/ipc-handlers.ts'
import type { MultiClientService } from './multi-service.ts'

const execFileAsync = promisify(execFile)

const MAX_BODY_BYTES = 32 * 1024 * 1024
const DIALOG_TIMEOUT_MS = 120_000

const STATIC_ASSETS: Record<
  string,
  { readonly dir: 'renderer' | 'assets'; readonly file: string; readonly mime: string }
> = {
  '/theme.css': { dir: 'renderer', file: 'theme.css', mime: 'text/css; charset=utf-8' },
  '/index.js': { dir: 'renderer', file: 'index.js', mime: 'application/javascript; charset=utf-8' },
  '/local-bridge.js': {
    dir: 'renderer',
    file: 'local-bridge.js',
    mime: 'application/javascript; charset=utf-8',
  },
  '/assets/icon.ico': { dir: 'assets', file: 'icon.ico', mime: 'image/x-icon' },
}

export interface LocalDesktopServerOptions {
  readonly rendererDir: string
  readonly assetsDir?: string
  readonly service: MultiClientService
  readonly dialog: DialogAdapter
  readonly appInfo: DesktopAppInfo
  readonly host?: string
  readonly port?: number
  readonly openExternal?: (url: string) => Promise<void>
}

export interface LocalDesktopServerHandle {
  readonly url: string
  readonly port: number
  readonly token: string
  close(): Promise<void>
}

async function runPowerShellDialog(script: string): Promise<string | null> {
  if (process.platform !== 'win32') {
    throw new Error('Windows PowerShell dialogs are only supported on win32')
  }
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    {
      windowsHide: true,
      timeout: DIALOG_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    },
  )
  const trimmed = stdout.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Create a {@link DialogAdapter} backed by Windows' signed `powershell.exe`
 * WinForms dialogs (`OpenFileDialog`, `SaveFileDialog`, `FolderBrowserDialog`).
 */
export function createWindowsPowerShellDialogAdapter(): DialogAdapter {
  return {
    async pickMemoryFile(mode) {
      if (mode === 'create') {
        const script = [
          'Add-Type -AssemblyName System.Windows.Forms',
          '$d = New-Object System.Windows.Forms.SaveFileDialog',
          "$d.Title = 'Memloom memory.json'",
          "$d.Filter = 'Memloom JSON (*.json)|*.json|All files (*.*)|*.*'",
          "$d.FileName = 'memory.json'",
          '$d.OverwritePrompt = $false',
          'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }',
        ].join('; ')
        return runPowerShellDialog(script)
      }
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d = New-Object System.Windows.Forms.OpenFileDialog',
        "$d.Title = 'Memloom memory.json'",
        "$d.Filter = 'Memloom JSON (*.json)|*.json|All files (*.*)|*.*'",
        '$d.CheckFileExists = $true',
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }',
      ].join('; ')
      return runPowerShellDialog(script)
    },

    async pickDirectory() {
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        "$d.Description = 'Select workspace directory'",
        '$d.ShowNewFolderButton = $true',
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
      ].join('; ')
      return runPowerShellDialog(script)
    },

    async pickImportJson() {
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d = New-Object System.Windows.Forms.OpenFileDialog',
        "$d.Title = 'Import Memloom JSON'",
        "$d.Filter = 'JSON files (*.json)|*.json|All files (*.*)|*.*'",
        '$d.CheckFileExists = $true',
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }',
      ].join('; ')
      const selected = await runPowerShellDialog(script)
      if (selected === null) return null
      const content = await fs.readFile(selected, 'utf8')
      return { path: selected, content }
    },

    async saveExportJson(defaultFileName, content) {
      const safeDefault = path.basename(defaultFileName).replace(/'/g, "''")
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d = New-Object System.Windows.Forms.SaveFileDialog',
        "$d.Title = 'Export Memloom JSON'",
        "$d.Filter = 'JSON files (*.json)|*.json'",
        `$d.FileName = '${safeDefault}'`,
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }',
      ].join('; ')
      const targetPath = await runPowerShellDialog(script)
      if (targetPath === null) return null
      await fs.writeFile(targetPath, content, 'utf8')
      return targetPath
    },
  }
}

/** Open an allowlisted external documentation URL in the OS default browser. */
export async function openExternalUrl(url: string): Promise<void> {
  if (!isAllowedExternalUrl(url)) {
    throw new Error('External URL is not allowlisted')
  }
  if (process.platform === 'win32') {
    await execFileAsync('cmd.exe', ['/c', 'start', '', url], { windowsHide: true })
    return
  }
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
  await execFileAsync(cmd, [url])
}

function tokensEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(payload)
}

class PayloadTooLargeError extends Error {}

async function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let done = false

    req.on('data', (chunk: Buffer) => {
      if (done) return
      total += chunk.length
      if (total > maxBytes) {
        done = true
        req.destroy()
        reject(new PayloadTooLargeError(`Request body exceeds ${maxBytes} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (err) => {
      if (done) return
      done = true
      reject(err)
    })
  })
}

export function injectBridgeHtml(rawHtml: string, token: string): string {
  const escapedToken = token.replace(/[^a-f0-9]/gi, '')
  let html = rawHtml.replace("connect-src 'none'", "connect-src 'self'")
  const metaTag = `    <link rel="icon" href="/assets/icon.ico" />\n    <meta name="memloom-session-token" content="${escapedToken}" />\n`
  if (html.includes('</head>')) {
    html = html.replace('</head>', `${metaTag}  </head>`)
  } else {
    html = `${metaTag}${html}`
  }
  const bridgeScript = '    <script defer src="./local-bridge.js"></script>\n'
  if (html.includes('<script defer src="./index.js"></script>')) {
    html = html.replace(
      '<script defer src="./index.js"></script>',
      `${bridgeScript}    <script defer src="./index.js"></script>`,
    )
  } else if (html.includes('</body>')) {
    html = html.replace('</body>', `${bridgeScript}  </body>`)
  }
  return html
}

/**
 * Start a loopback-only, token-authenticated local HTTP/RPC server wrapping
 * {@link createDesktopIpcHandlers} for signed browser shells such as Edge `--app`.
 */
export async function startLocalDesktopServer(
  options: LocalDesktopServerOptions,
): Promise<LocalDesktopServerHandle> {
  const host = options.host ?? '127.0.0.1'
  const requestedPort = options.port ?? 0
  const rendererDir = path.resolve(options.rendererDir)
  const assetsDir = path.resolve(options.assetsDir ?? path.join(rendererDir, '..', 'assets'))
  const token = randomBytes(32).toString('hex')

  const handlers = createDesktopIpcHandlers({
    service: options.service,
    dialog: options.dialog,
    appInfo: options.appInfo,
    openExternal: options.openExternal ?? openExternalUrl,
  })

  let actualPort = requestedPort

  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = (req.url ?? '/').split('?')[0] ?? '/'

      if (req.method === 'GET' && (urlPath === '/' || urlPath === '/index.html')) {
        const rawHtml = await fs.readFile(path.join(rendererDir, 'index.html'), 'utf8')
        const html = Buffer.from(injectBridgeHtml(rawHtml, token), 'utf8')
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': String(html.length),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        })
        res.end(html)
        return
      }

      if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(STATIC_ASSETS, urlPath)) {
        const asset = STATIC_ASSETS[urlPath]!
        const baseDir = asset.dir === 'renderer' ? rendererDir : assetsDir
        const content = await fs.readFile(path.join(baseDir, asset.file))
        res.writeHead(200, {
          'Content-Type': asset.mime,
          'Content-Length': String(content.length),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        })
        res.end(content)
        return
      }

      if (req.method === 'POST' && urlPath === '/api/invoke') {
        const origin = req.headers.origin
        const expectedOrigin = `http://${host}:${actualPort}`
        if (origin !== undefined && origin !== expectedOrigin) {
          sendJson(res, 403, {
            ok: false,
            error: { code: 'memory/forbidden', message: 'Cross-origin request rejected' },
          })
          return
        }

        const headerToken = req.headers['x-memloom-token']
        if (typeof headerToken !== 'string' || !tokensEqual(headerToken, token)) {
          sendJson(res, 403, {
            ok: false,
            error: { code: 'memory/forbidden', message: 'Invalid or missing session token' },
          })
          return
        }

        let rawBody: string
        try {
          rawBody = await readRequestBody(req, MAX_BODY_BYTES)
        } catch (err) {
          if (err instanceof PayloadTooLargeError) {
            sendJson(res, 413, {
              ok: false,
              error: { code: 'desktop/invalid-args', message: err.message },
            })
            return
          }
          throw err
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(rawBody)
        } catch {
          sendJson(res, 400, {
            ok: false,
            error: { code: 'desktop/invalid-args', message: 'Invalid JSON request body' },
          })
          return
        }

        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          sendJson(res, 400, {
            ok: false,
            error: { code: 'desktop/invalid-args', message: 'Request body must be an object' },
          })
          return
        }

        const channel = (parsed as { channel?: unknown }).channel
        const payload = (parsed as { payload?: unknown }).payload
        if (
          typeof channel !== 'string' ||
          !Object.prototype.hasOwnProperty.call(handlers, channel)
        ) {
          sendJson(res, 404, {
            ok: false,
            error: {
              code: 'desktop/unsupported',
              message: `Unknown IPC channel: ${String(channel)}`,
            },
          })
          return
        }

        const result = await handlers[channel]!(payload)
        sendJson(res, 200, result)
        return
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 500, {
        ok: false,
        error: { code: 'desktop/internal', message },
      })
    }
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(requestedPort, host, () => {
      server.off('error', rejectListen)
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        rejectListen(new Error('Failed to bind local desktop server port'))
        return
      }
      actualPort = addr.port
      resolveListen()
    })
  })

  return {
    url: `http://${host}:${actualPort}/`,
    port: actualPort,
    token,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose())
      }),
  }
}
