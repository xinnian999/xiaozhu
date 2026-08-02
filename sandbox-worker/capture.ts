/// <reference lib="dom" />

import { chmod, readFile, readdir, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

export const CAPTURE_VIEWPORTS = {
  desktop: { width: 1280, height: 720 },
  mobile: { width: 390, height: 844 },
} as const

export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024
const MAX_RUNTIME_ERRORS = 20
const MAX_RUNTIME_ERROR_LENGTH = 1_000

export type PreviewDevice = keyof typeof CAPTURE_VIEWPORTS

export type PreviewScreenshot = {
  data_base64: string
  mime: 'image/jpeg'
  width: number
  height: number
  path: string
  device: PreviewDevice
}

export type CaptureOutcome = {
  screenshot?: PreviewScreenshot
  capture_error?: string
  runtime_errors?: string[]
}

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function describeError(error: unknown): string {
  return error instanceof Error ? (error.stack || error.message) : String(error)
}

function clipRuntimeError(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_RUNTIME_ERROR_LENGTH)
}

export function isAllowedCaptureUrl(rawUrl: string, previewOrigin: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') {
      return true
    }
    return url.protocol === 'http:' && url.origin === previewOrigin
  } catch {
    return false
  }
}

async function resolveStaticAsset(root: string, rawPathname: string): Promise<string | null> {
  let pathname: string
  try {
    pathname = decodeURIComponent(rawPathname)
  } catch {
    return null
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return null

  const relative = pathname.replace(/^\/+/, '') || 'index.html'
  const resolved = path.resolve(root, relative)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null

  try {
    const info = await stat(resolved)
    if (info.isFile()) return resolved
    if (info.isDirectory()) {
      const indexPath = path.join(resolved, 'index.html')
      if ((await stat(indexPath)).isFile()) return indexPath
    }
  } catch {
    // SPA 的前端路由没有实体文件时回退到可信构建入口。
  }
  if (!path.posix.extname(pathname)) return path.join(root, 'index.html')
  return null
}

async function startStaticPreviewServer(root: string): Promise<{ server: Server; origin: string }> {
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' })
        response.end()
        return
      }
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      const assetPath = await resolveStaticAsset(root, url.pathname)
      if (!assetPath) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('Not found')
        return
      }
      const body = await readFile(assetPath)
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Length': String(body.byteLength),
        'Content-Type': contentTypes[path.extname(assetPath).toLowerCase()]
          || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      })
      response.end(request.method === 'HEAD' ? undefined : body)
    } catch {
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      }
      response.end('Internal error')
    }
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function settleWithin(task: Promise<unknown> | undefined, timeoutMs: number): Promise<void> {
  if (!task) return
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    task.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
      timer.unref()
    }),
  ])
  if (timer) clearTimeout(timer)
}

async function finishBefore<T>(
  task: Promise<T>,
  deadline: number,
  timeoutMessage: string,
): Promise<T> {
  const remainingMs = Math.max(1, deadline - Date.now())
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    task,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(timeoutMessage)), remainingMs)
      timer.unref()
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function remainingBefore(deadline: number, upperBoundMs: number): number {
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) throw new Error('Playwright 截图超过时间限制')
  return Math.max(1, Math.min(remainingMs, upperBoundMs))
}

export async function makePreviewTreeReadable(root: string): Promise<void> {
  // 源码 jobs 保持 0700/0600；只有已构建的静态预览需要让无 DAC capability 的 API 读取。
  const entries = await readdir(root, { withFileTypes: true })
  await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) {
      await makePreviewTreeReadable(target)
      return
    }
    if (entry.isFile()) await chmod(target, 0o644)
    // 正常 Vite dist 不含符号链接；异常文件类型保持不可访问，API 也会拒绝。
  }))
  await chmod(root, 0o755)
}

async function waitForVisualStability(page: Page): Promise<void> {
  // 应用挂载、字体和图片只做有界等待；远端资源已被网络路由拦截，不能拖住截图。
  await page.waitForFunction(() => {
    const root = document.getElementById('root')
    return Boolean(root && (root.firstElementChild || (root.textContent || '').trim()))
  }, undefined, { timeout: 3_000 }).catch(() => undefined)
  await page.evaluate(async () => {
    const waitAtMost = (value: Promise<unknown>, timeout: number) => Promise.race([
      value.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, timeout)),
    ])
    const images = Array.from(document.images).map(async (image) => {
      if (!image.complete) {
        await Promise.race([
          new Promise((resolve) => {
            image.addEventListener('load', resolve, { once: true })
            image.addEventListener('error', resolve, { once: true })
          }),
          new Promise((resolve) => setTimeout(resolve, 1_000)),
        ])
      }
      if (typeof image.decode === 'function') await waitAtMost(image.decode(), 1_000)
    })
    if (document.fonts?.ready) await waitAtMost(document.fonts.ready, 1_500)
    await Promise.all(images)
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  await page.addStyleTag({
    content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
  })
  await page.waitForTimeout(120)
}

async function takeBoundedJpeg(page: Page): Promise<Buffer> {
  for (const quality of [75, 55, 35]) {
    const image = await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
      fullPage: false,
      quality,
      type: 'jpeg',
    })
    if (image.byteLength <= MAX_SCREENSHOT_BYTES) return image
  }
  throw new Error('截图压缩后仍超过 2MB 限制')
}

function logicalPath(rawUrl: string, previewOrigin: string): string {
  try {
    const url = new URL(rawUrl)
    if (url.origin !== previewOrigin) return '/'
    return `${url.pathname || '/'}${url.search}${url.hash}`.slice(0, 2_048)
  } catch {
    return '/'
  }
}

export async function capturePreview(
  previewDir: string,
  device: PreviewDevice,
  timeoutMs: number,
): Promise<CaptureOutcome> {
  const runtimeErrors: string[] = []
  const seenRuntimeErrors = new Set<string>()
  const pushRuntimeError = (kind: string, value: string) => {
    if (runtimeErrors.length >= MAX_RUNTIME_ERRORS) return
    const message = clipRuntimeError(`${kind}: ${value}`)
    if (!message || seenRuntimeErrors.has(message)) return
    seenRuntimeErrors.add(message)
    runtimeErrors.push(message)
  }

  let server: Server | undefined
  let browser: Browser | undefined
  let context: BrowserContext | undefined
  try {
    const localPreview = await startStaticPreviewServer(previewDir)
    server = localPreview.server
    // 统一 deadline 覆盖浏览器启动、Context/Page 创建、导航、稳定等待与截图；
    // 不能只限制 page.goto，否则异常浏览器可能长期占住全局单并发。
    const deadline = Date.now() + timeoutMs
    const viewport = CAPTURE_VIEWPORTS[device]
    const configuredExecutable = process.env.SANDBOX_CHROMIUM_EXECUTABLE_PATH?.trim()
    browser = await finishBefore(chromium.launch({
      headless: true,
      timeout: remainingBefore(deadline, 10_000),
      ...(configuredExecutable ? { executablePath: configuredExecutable } : {}),
      // 浏览器不继承 Worker token；只保留启动与临时目录所需的非敏感环境。
      env: {
        HOME: process.env.HOME || '/tmp',
        LANG: process.env.LANG || 'C.UTF-8',
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        TMPDIR: process.env.TMPDIR || '/tmp',
        TZ: process.env.TZ || 'Asia/Shanghai',
      },
      args: [
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-extensions',
        '--disable-sync',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--metrics-recording-only',
        '--no-first-run',
      ],
    }), deadline, 'Playwright 浏览器启动超过时间限制')
    context = await finishBefore(browser.newContext({
      acceptDownloads: false,
      colorScheme: 'light',
      deviceScaleFactor: 1,
      hasTouch: device === 'mobile',
      isMobile: device === 'mobile',
      javaScriptEnabled: true,
      locale: 'zh-CN',
      serviceWorkers: 'block',
      viewport,
    }), deadline, 'Playwright Context 创建超过时间限制')
    context.setDefaultTimeout(remainingBefore(deadline, 5_000))
    context.setDefaultNavigationTimeout(remainingBefore(deadline, 8_000))

    await context.route('**/*', async (route) => {
      const requestUrl = route.request().url()
      if (isAllowedCaptureUrl(requestUrl, localPreview.origin)) {
        await route.continue()
        return
      }
      await route.abort('blockedbyclient')
    })
    await context.routeWebSocket('**/*', async (webSocket) => {
      await webSocket.close({ code: 1008, reason: 'External network is disabled' })
    })

    const attachPageListeners = (target: Page) => {
      target.on('pageerror', (error) => pushRuntimeError('pageerror', describeError(error)))
      target.on('console', (message) => {
        if (message.type() !== 'error') return
        const text = message.text()
        if (
          text.includes('ERR_BLOCKED_BY_CLIENT')
          || text.startsWith('WebSocket connection to')
        ) return
        pushRuntimeError('console', text)
      })
      target.on('crash', () => pushRuntimeError('pageerror', '页面渲染进程崩溃'))
      target.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined))
    }
    let mainPage: Page | undefined
    context.on('page', (target) => {
      attachPageListeners(target)
      // 生成代码可能用 window.open 刷出大量页面；截图只需要一个主页面。
      if (mainPage && target !== mainPage) void target.close().catch(() => undefined)
    })
    const page = await finishBefore(
      context.newPage(),
      deadline,
      'Playwright Page 创建超过时间限制',
    )
    mainPage = page

    const screenshot = await finishBefore(
      (async (): Promise<PreviewScreenshot> => {
        await page.goto(`${localPreview.origin}/`, { waitUntil: 'domcontentloaded' })
        await waitForVisualStability(page)
        const image = await takeBoundedJpeg(page)
        return {
          data_base64: image.toString('base64'),
          mime: 'image/jpeg',
          width: viewport.width,
          height: viewport.height,
          path: logicalPath(page.url(), localPreview.origin),
          device,
        }
      })(),
      deadline,
      'Playwright 截图超过时间限制',
    )
    return {
      screenshot,
      ...(runtimeErrors.length > 0 ? { runtime_errors: runtimeErrors } : {}),
    }
  } catch (error) {
    return {
      capture_error: clipRuntimeError(describeError(error)) || 'Playwright 截图失败',
      ...(runtimeErrors.length > 0 ? { runtime_errors: runtimeErrors } : {}),
    }
  } finally {
    // 清理也必须有界；异常页面不能借由卡住 close() 永久占用全局单并发锁。
    await settleWithin(context?.close(), 1_500)
    await settleWithin(browser?.close(), 3_000)
    await settleWithin(closeServer(server), 1_000)
  }
}
