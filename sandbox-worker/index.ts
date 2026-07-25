import { mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

const port = Number.parseInt(process.env.SANDBOX_PORT || '8010', 10)
const dataDir = process.env.SANDBOX_DATA_DIR || '/data'
const workerToken = process.env.SANDBOX_WORKER_TOKEN || ''
const publicBaseUrl = (process.env.SANDBOX_PUBLIC_BASE_URL || `http://localhost:${port}`)
  .replace(/\/+$/, '')
const frameAncestors = process.env.SANDBOX_FRAME_ANCESTORS || '*'
const buildTimeoutMs = Math.max(
  5_000,
  Math.min(Number.parseInt(process.env.SANDBOX_BUILD_TIMEOUT_MS || '60000', 10), 120_000),
)

// 容器内固定为 /opt/template；允许测试环境覆盖，便于不启动 Docker 也能做真实构建验证。
const templateDir = process.env.SANDBOX_TEMPLATE_DIR || '/opt/template'
const jobsDir = path.join(dataDir, 'jobs')
const previewsDir = path.join(dataDir, 'previews')
const MAX_FILES = 200
const MAX_FILE_BYTES = 512 * 1024
const MAX_TOTAL_BYTES = 5 * 1024 * 1024
const MAX_LOG_BYTES = 100 * 1024
const MAX_PREVIEWS_PER_SESSION = 3

const protectedFiles = [
  '.npmrc',
  'package.json',
  'index.html',
  'postcss.config.js',
  'tailwind.config.js',
  'tsconfig.json',
  'vite.config.ts',
] as const
const protectedFileSet = new Set<string>(protectedFiles)

type BuildPayload = {
  session_id: string
  files: Record<string, string>
  device?: 'desktop' | 'mobile'
}

type BuildResult = {
  ok: boolean
  build_id?: string
  preview_url?: string
  logs: string
  errors: string
}

let building = false

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}

function clipLog(value: string): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength <= MAX_LOG_BYTES) return value
  return `${new TextDecoder().decode(bytes.slice(0, MAX_LOG_BYTES))}\n…日志已截断`
}

export function safeRelativePath(input: string): string | null {
  if (!input || input.includes('\0') || input.includes('\\') || path.posix.isAbsolute(input)) {
    return null
  }
  const normalized = path.posix.normalize(input)
  if (
    normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.startsWith('node_modules/')
    || normalized.startsWith('dist/')
    || normalized.startsWith('.git/')
  ) return null
  return normalized
}

function validatePayload(value: unknown): BuildPayload {
  if (typeof value !== 'object' || value === null) throw new Error('请求体必须是对象')
  const body = value as Record<string, unknown>
  if (
    typeof body.session_id !== 'string'
    || !/^[A-Za-z0-9-]{1,80}$/.test(body.session_id)
  ) throw new Error('session_id 无效')
  if (typeof body.files !== 'object' || body.files === null || Array.isArray(body.files)) {
    throw new Error('files 必须是文件映射')
  }

  const entries = Object.entries(body.files as Record<string, unknown>)
  if (entries.length === 0 || entries.length > MAX_FILES) {
    throw new Error(`文件数量必须在 1–${MAX_FILES} 之间`)
  }
  const files: Record<string, string> = {}
  let totalBytes = 0
  for (const [rawPath, content] of entries) {
    const filePath = safeRelativePath(rawPath)
    if (!filePath || typeof content !== 'string') throw new Error(`文件无效: ${rawPath}`)
    const size = Buffer.byteLength(content, 'utf8')
    if (size > MAX_FILE_BYTES) throw new Error(`单个文件超过 512KB: ${filePath}`)
    totalBytes += size
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('项目源码总大小超过 5MB')
    // 骨架文件稍后从只读模板覆盖；这里直接忽略客户端版本。
    if (!protectedFileSet.has(filePath)) files[filePath] = content
  }
  return {
    session_id: body.session_id,
    files,
    device: body.device === 'mobile' ? 'mobile' : 'desktop',
  }
}

function runtimeBridge(): string {
  return `<script>
(() => {
  const documentId = 'server-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const send = (type, payload = {}) => {
    try { window.parent.postMessage({ type, documentId, ...payload }, '*'); } catch {}
  };
  const describe = (value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  window.addEventListener('error', (event) => {
    send('xiaozhu-server-runtime-error', { message: describe(event.error || event.message) });
  });
  window.addEventListener('unhandledrejection', (event) => {
    send('xiaozhu-server-runtime-error', { message: describe(event.reason) });
  });
  const originalConsoleError = console.error.bind(console);
  console.error = (...args) => {
    send('xiaozhu-server-runtime-error', { message: args.map(describe).join(' ') });
    originalConsoleError(...args);
  };
  const reportPath = () => send('xiaozhu-server-navigation', {
    path: location.pathname + location.search + location.hash,
  });
  window.addEventListener('hashchange', reportPath);
  window.addEventListener('popstate', reportPath);
  window.addEventListener('load', () => {
    reportPath();
    send('xiaozhu-server-ready', { width: innerWidth, height: innerHeight });
  });
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'xiaozhu-nav-cmd') return;
    if (data.action === 'back') history.back();
    else if (data.action === 'forward') history.forward();
    else if (data.action === 'reload') location.reload();
  });
})();
</script>`
}

async function writeJobFiles(jobDir: string, files: Record<string, string>): Promise<void> {
  for (const [filePath, content] of Object.entries(files)) {
    const target = path.join(jobDir, ...filePath.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  for (const filePath of protectedFiles) {
    let content = await readFile(path.join(templateDir, filePath), 'utf8')
    if (filePath === 'index.html') {
      content = content.replace('</head>', `${runtimeBridge()}\n</head>`)
    }
    await writeFile(path.join(jobDir, filePath), content, 'utf8')
  }
  await symlink(path.join(templateDir, 'node_modules'), path.join(jobDir, 'node_modules'), 'dir')
}

async function runViteBuild(jobDir: string): Promise<{ code: number; output: string; timedOut: boolean }> {
  const vite = path.join(templateDir, 'node_modules', '.bin', 'vite')
  const proc = Bun.spawn(
    [vite, 'build', '--base=./', '--emptyOutDir'],
    {
      cwd: jobDir,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        CI: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const stdoutPromise = new Response(proc.stdout).text()
  const stderrPromise = new Response(proc.stderr).text()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { proc.kill(9) } catch {}
  }, buildTimeoutMs)
  const code = await proc.exited
  clearTimeout(timer)
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
  return {
    code,
    output: clipLog([stdout, stderr].filter(Boolean).join('\n').trim()),
    timedOut,
  }
}

async function pruneSessionPreviews(sessionId: string): Promise<void> {
  const sessionDir = path.join(previewsDir, sessionId)
  const names = await readdir(sessionDir).catch(() => [])
  const rows = await Promise.all(
    names.map(async (name) => ({
      name,
      mtime: (await stat(path.join(sessionDir, name))).mtimeMs,
    })),
  )
  rows.sort((a, b) => b.mtime - a.mtime)
  await Promise.all(
    rows.slice(MAX_PREVIEWS_PER_SESSION).map((row) =>
      rm(path.join(sessionDir, row.name), { recursive: true, force: true }),
    ),
  )
}

async function build(payload: BuildPayload): Promise<BuildResult> {
  const buildId = crypto.randomUUID()
  const jobDir = path.join(jobsDir, buildId)
  const previewDir = path.join(previewsDir, payload.session_id, buildId)
  await mkdir(jobDir, { recursive: true })
  try {
    await writeJobFiles(jobDir, payload.files)
    const result = await runViteBuild(jobDir)
    if (result.timedOut) {
      return { ok: false, logs: result.output, errors: '构建超过时间限制，已终止' }
    }
    if (result.code !== 0) {
      return {
        ok: false,
        logs: result.output,
        errors: result.output || `vite build 失败 (exit ${result.code})`,
      }
    }
    await mkdir(path.dirname(previewDir), { recursive: true })
    await Bun.write(
      path.join(jobDir, 'dist', '.xiaozhu-build.json'),
      JSON.stringify({ sessionId: payload.session_id, buildId, device: payload.device }),
    )
    await rename(path.join(jobDir, 'dist'), previewDir)
    await pruneSessionPreviews(payload.session_id)
    return {
      ok: true,
      build_id: buildId,
      preview_url:
        `${publicBaseUrl}/preview/${encodeURIComponent(payload.session_id)}/${buildId}/`,
      logs: result.output,
      errors: '',
    }
  } finally {
    await rm(jobDir, { recursive: true, force: true })
  }
}

function previewHeaders(): HeadersInit {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      `default-src 'self' data: blob: https:; `
      + `script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; `
      + `style-src 'self' 'unsafe-inline' https:; `
      + `img-src 'self' data: blob: https:; font-src 'self' data: https:; `
      + `connect-src 'self' https: wss:; frame-ancestors ${frameAncestors}`,
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  }
}

async function servePreview(url: URL): Promise<Response> {
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 3 || parts[0] !== 'preview') return new Response('Not found', { status: 404 })
  const sessionId = parts[1]
  const buildId = parts[2]
  if (!/^[A-Za-z0-9-]{1,80}$/.test(sessionId) || !/^[a-f0-9-]{36}$/.test(buildId)) {
    return new Response('Not found', { status: 404 })
  }
  const rawFile = parts.slice(3).join('/') || 'index.html'
  const filePath = safeRelativePath(rawFile)
  if (!filePath) return new Response('Not found', { status: 404 })
  const root = path.join(previewsDir, sessionId, buildId)
  const target = path.resolve(root, filePath)
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) {
    return new Response('Not found', { status: 404 })
  }
  const file = Bun.file(target)
  if (!(await file.exists())) return new Response('Not found', { status: 404 })
  return new Response(file, { headers: previewHeaders() })
}

await mkdir(jobsDir, { recursive: true })
await mkdir(previewsDir, { recursive: true })

const server = Bun.serve({
  port,
  hostname: '0.0.0.0',
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'ok', building })
    }
    if (request.method === 'GET' && url.pathname.startsWith('/preview/')) {
      return servePreview(url)
    }
    if (request.method !== 'POST' || url.pathname !== '/internal/build') {
      return new Response('Not found', { status: 404 })
    }
    if (!workerToken || request.headers.get('Authorization') !== `Bearer ${workerToken}`) {
      return json({ error: '无效 Worker 凭证' }, 401)
    }
    const contentLength = Number.parseInt(request.headers.get('content-length') || '0', 10)
    if (contentLength > MAX_TOTAL_BYTES + 1024 * 1024) {
      return json({ error: '请求体过大' }, 413)
    }
    if (building) return json({ error: '当前已有构建任务' }, 429)

    let payload: BuildPayload
    try {
      payload = validatePayload(await request.json())
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }

    building = true
    try {
      return json(await build(payload))
    } catch (error) {
      console.error('sandbox build failed', error)
      return json({ error: 'Worker 内部错误' }, 500)
    } finally {
      building = false
    }
  },
})

console.log(`xiaozhu sandbox worker listening on ${server.hostname}:${server.port}`)
