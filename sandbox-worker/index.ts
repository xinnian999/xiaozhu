import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import type { Readable } from 'node:stream'

import { PREVIEW_CAPABILITY_PATH_PATTERN_SOURCE } from './preview-path.ts'

const port = Number.parseInt(process.env.SANDBOX_PORT || '8010', 10)
const hostname = process.env.SANDBOX_HOST || '0.0.0.0'
const dataDir = process.env.SANDBOX_DATA_DIR || '/data'
const workerToken = process.env.SANDBOX_WORKER_TOKEN || ''
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
const MAX_WIRE_BYTES = 32 * 1024 * 1024
const MAX_LOG_BYTES = 100 * 1024
const MAX_PREVIEWS_PER_SESSION = 3
// 修改可信模板、构建器或运行时 bridge 后递增，避免复用旧格式产物。
const BUILD_CACHE_VERSION = '2'

const protectedFiles = [
  '.npmrc',
  'package.json',
  'index.html',
  'postcss.config.js',
  'tailwind.config.js',
  'tsconfig.json',
  'vite.config.ts',
] as const
// Vite/PostCSS/Tailwind 都支持多种配置文件名。即使可信模板使用 .ts/.js，
// 也不能把其它后缀写进任务根目录，否则工具的默认搜索顺序可能优先执行用户 JS。
const protectedInputFileSet = new Set<string>([
  ...protectedFiles,
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
  'vite.config.mts',
  'vite.config.cts',
  'postcss.config.cjs',
  'postcss.config.mjs',
  'postcss.config.ts',
  'postcss.config.mts',
  'postcss.config.cts',
  'tailwind.config.cjs',
  'tailwind.config.mjs',
  'tailwind.config.ts',
  'tailwind.config.mts',
  'tailwind.config.cts',
  '.postcssrc',
  '.postcssrc.json',
  '.postcssrc.yaml',
  '.postcssrc.yml',
  '.postcssrc.js',
  '.postcssrc.cjs',
  '.postcssrc.mjs',
  '.postcssrc.ts',
  '.postcssrc.mts',
  '.postcssrc.cts',
])
const unsafeCssDirective = /@(?:config|plugin)\b/i
const cssFilePattern = /\.(?:css|pcss|postcss)$/i

type BuildPayload = {
  session_id: string
  files: Record<string, string>
  device?: 'desktop' | 'mobile'
}

type BuildResult = {
  ok: boolean
  build_id?: string
  logs: string
  errors: string
}

let building = false

class PayloadTooLargeError extends Error {}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(body))
}

function clipLog(value: string): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength <= MAX_LOG_BYTES) return value
  return `${new TextDecoder().decode(bytes.slice(0, MAX_LOG_BYTES))}\n…日志已截断`
}

async function readJsonWithLimit(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.byteLength
    if (totalBytes > MAX_WIRE_BYTES) {
      // 继续排空 socket，避免大请求提前返回时破坏 keep-alive 连接。
      request.resume()
      throw new PayloadTooLargeError('请求体超过 32MiB')
    }
    chunks.push(buffer)
  }
  if (totalBytes === 0) throw new Error('请求体不能为空')
  const body = Buffer.concat(chunks, totalBytes)
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
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
    || normalized === 'node_modules'
    || normalized.startsWith('node_modules/')
    || normalized === 'dist'
    || normalized.startsWith('dist/')
    || normalized === '.git'
    || normalized.startsWith('.git/')
  ) return null
  return normalized
}

type LocalCssReference = {
  path: string
  bare: boolean
}

function localCssPath(
  fromFile: string,
  reference: string,
  files: Record<string, string>,
): LocalCssReference | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(reference)
  } catch {
    throw new Error(`CSS 资源路径编码无效: ${fromFile}`)
  }
  if (
    !decoded
    || decoded.startsWith('#')
    || /^(?:data|blob|https?):/i.test(decoded)
    || decoded.startsWith('//')
  ) return null
  if (
    decoded.includes('\0')
    || decoded.includes('\\')
    || /^file:/i.test(decoded)
    // 防止 Vite / URL 层再次解码后才变成 ../、斜杠或 NUL。
    || /%(?:00|2e|2f|5c)/i.test(decoded)
  ) {
    throw new Error(`CSS 禁止读取本地路径: ${fromFile}`)
  }
  const withoutSuffix = decoded.split(/[?#]/, 1)[0]
  if (!withoutSuffix) return null
  if (withoutSuffix.startsWith('/')) {
    const publicPath = `public${withoutSuffix}`
    if (!(publicPath in files)) {
      throw new Error(`CSS 绝对资源必须来自 public/: ${fromFile}`)
    }
    return { path: publicPath, bare: false }
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile), withoutSuffix),
  )
  if (
    path.posix.isAbsolute(resolved)
    || resolved === '..'
    || resolved.startsWith('../')
  ) {
    throw new Error(`CSS 禁止越过项目目录: ${fromFile}`)
  }
  return {
    path: resolved,
    bare: !withoutSuffix.startsWith('.'),
  }
}

function stripCssComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, ' ')
}

function validateCssGraph(files: Record<string, string>): void {
  const pending = Object.keys(files).filter((filePath) => cssFilePattern.test(filePath))
  const visited = new Set<string>()
  const importPattern =
    /@import\s+(?:url\(\s*(?:(['"])(.*?)\1|([^'")\s]+))\s*\)|(['"])(.*?)\4|([^;\s]+))/gi
  const urlPattern = /url\(\s*(?:(['"])(.*?)\1|([^'")\s]+))\s*\)/gi

  while (pending.length > 0) {
    const filePath = pending.pop()!
    if (visited.has(filePath)) continue
    visited.add(filePath)
    const content = files[filePath]
    if (content === undefined) continue
    const css = stripCssComments(content)
    if (unsafeCssDirective.test(css)) {
      throw new Error(`样式文件禁止使用 @config/@plugin: ${filePath}`)
    }

    for (const match of css.matchAll(importPattern)) {
      const rawReference = match[2] ?? match[3] ?? match[5] ?? match[6]
      const resolved = localCssPath(filePath, rawReference, files)
      if (!resolved) continue
      const candidates = [
        resolved.path,
        `${resolved.path}.css`,
        `${resolved.path}.pcss`,
        `${resolved.path}.postcss`,
        `${resolved.path}/index.css`,
      ]
      const imported = candidates.find((candidate) => candidate in files)
      if (imported) {
        // 扩展名不可信：被 CSS @import 到的 .txt/.svg 等同样按样式表递归审查。
        pending.push(imported)
      } else if (!resolved.bare) {
        throw new Error(`CSS 引用的本地文件不存在: ${filePath} -> ${rawReference}`)
      }
    }
    // @import url(...) 已在上面按“样式依赖”处理，不能再次误当成图片/字体资源。
    const cssWithoutImports = css.replace(importPattern, ' ')
    for (const match of cssWithoutImports.matchAll(urlPattern)) {
      const rawReference = match[2] ?? match[3]
      const resolved = localCssPath(filePath, rawReference, files)
      if (resolved && !(resolved.path in files)) {
        throw new Error(`CSS 资源不在项目文件中: ${filePath} -> ${rawReference}`)
      }
    }
  }
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
    if (!protectedInputFileSet.has(filePath)) files[filePath] = content
  }
  validateCssGraph(files)
  return {
    session_id: body.session_id,
    files,
    device: body.device === 'mobile' ? 'mobile' : 'desktop',
  }
}

function runtimeBridge(): string {
  return `<script type="module">
import html2canvas from 'html2canvas';
(() => {
  if (window.__xiaozhuServerBridge) return;
  window.__xiaozhuServerBridge = true;
  const documentId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'server-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const post = (type, payload = {}, targetOrigin = '*', transfer = []) => {
    try {
      window.parent.postMessage({ type, ...payload, documentId }, targetOrigin, transfer);
    } catch {}
  };
  const describe = (value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === 'string') return value;
    try {
      const encoded = JSON.stringify(value);
      return typeof encoded === 'string' ? encoded : String(value);
    } catch {
      return String(value);
    }
  };
  window.addEventListener('error', (event) => {
    const target = event.target;
    if (target && target !== window && target instanceof Element) {
      const source = target.currentSrc || target.src || target.href
        || target.getAttribute('src') || target.getAttribute('href') || '';
      post('xiaozhu-server-runtime-error', {
        kind: 'resource',
        message: ('静态资源加载失败: ' + target.tagName.toLowerCase()
          + (source ? ' ' + source : '')).slice(0, 4000),
      });
      return;
    }
    post('xiaozhu-server-runtime-error', {
      kind: 'script',
      message: describe(event.error || event.message).slice(0, 4000),
    });
  }, true);
  window.addEventListener('unhandledrejection', (event) => {
    post('xiaozhu-server-runtime-error', {
      kind: 'promise',
      message: describe(event.reason).slice(0, 4000),
    });
  });
  const originalConsoleError = console.error.bind(console);
  console.error = (...args) => {
    post('xiaozhu-server-runtime-error', {
      kind: 'console',
      message: args.map(describe).join(' ').slice(0, 4000),
    });
    originalConsoleError(...args);
  };
  const previewCapabilityPrefix = new RegExp(
    ${JSON.stringify(PREVIEW_CAPABILITY_PATH_PATTERN_SOURCE)}
  );
  const logicalPreviewPath = () => {
    const strippedPath = location.pathname.replace(previewCapabilityPrefix, '');
    const normalizedPath = strippedPath
      ? (strippedPath.startsWith('/') ? strippedPath : '/' + strippedPath)
      : '/';
    const params = new URLSearchParams(location.search);
    params.delete('__xiaozhu_reload');
    const logicalSearch = params.toString();
    return normalizedPath + (logicalSearch ? '?' + logicalSearch : '') + location.hash;
  };
  const reportPath = () => post('xiaozhu-server-navigation', {
    path: logicalPreviewPath(),
  });
  // pushState / replaceState 本身不会触发 popstate。React Router、Vue Router 等 SPA
  // 正是靠这两个 API 切路由，所以必须主动补发导航事件，父页面地址栏才会实时同步。
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method].bind(history);
    history[method] = (...args) => {
      const result = original(...args);
      queueMicrotask(reportPath);
      return result;
    };
  }
  window.addEventListener('hashchange', reportPath);
  window.addEventListener('popstate', reportPath);

  const waitAtMost = (value, timeout) => new Promise((resolve) => {
    const timer = setTimeout(resolve, timeout);
    Promise.resolve(value).then(() => {
      clearTimeout(timer);
      resolve();
    }, () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const waitForStylesheets = () => Promise.all(
    Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((link) => {
      if (link.sheet) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => resolve();
        link.addEventListener('load', done, { once: true });
        link.addEventListener('error', done, { once: true });
        setTimeout(done, 1500);
      });
    }),
  );
  const waitForImages = async () => {
    await Promise.all(Array.from(document.images || []).map(async (image) => {
      try {
        if (!image.complete) {
          await new Promise((resolve) => {
            const done = () => resolve();
            image.addEventListener('load', done, { once: true });
            image.addEventListener('error', done, { once: true });
            setTimeout(done, 1200);
          });
        }
        if (typeof image.decode === 'function') await waitAtMost(image.decode(), 1200);
      } catch {}
    }));
  };
  const waitForFonts = async () => {
    try {
      if (document.fonts && document.fonts.ready) {
        await waitAtMost(document.fonts.ready, 1500);
      }
    } catch {}
  };
  const waitForDomQuiet = () => new Promise((resolve) => {
    let settled = false;
    let quietTimer = 0;
    let mutationObserver = null;
    let resizeObserver = null;
    const maxTimer = setTimeout(finish, 1800);
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer);
      clearTimeout(maxTimer);
      if (mutationObserver) mutationObserver.disconnect();
      if (resizeObserver) resizeObserver.disconnect();
      resolve();
    }
    const bump = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, 320);
    };
    if (typeof MutationObserver === 'function') {
      mutationObserver = new MutationObserver(bump);
      mutationObserver.observe(document.documentElement, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(bump);
      resizeObserver.observe(document.documentElement);
      if (document.body) resizeObserver.observe(document.body);
    }
    bump();
  });
  const waitForAssets = async () => {
    await waitForStylesheets();
    await waitForFonts();
    await waitForImages();
    await waitForDomQuiet();
    // quiet 期间应用可能刚插入新资源；再扫描一次，避免 ready/capture 抢跑。
    await waitForStylesheets();
    await waitForFonts();
    await waitForImages();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  };
  const waitForAppMounted = () => new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      const root = document.getElementById('root');
      if (
        (root && (root.firstElementChild || (root.textContent || '').trim()))
        || Date.now() - startedAt >= 3000
      ) {
        resolve();
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });

  const safeBackground = (value) => {
    if (
      typeof value === 'string'
      && value.length <= 64
      && typeof CSS !== 'undefined'
      && CSS.supports('color', value)
    ) return value;
    return '#ffffff';
  };
  const toWebp = (canvas) => new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob && blob.type === 'image/webp') resolve(blob);
      else reject(new Error('浏览器未能编码 WebP 截图'));
    }, 'image/webp', 0.75);
  });
  const capture = async (background) => {
    // 字体或第三方图片可能长时间不结束；截图尽量等稳定，但不能被它们无限拖住。
    await waitAtMost(waitForAssets(), 4000);
    const viewportWidth = Math.max(
      1,
      innerWidth || document.documentElement.clientWidth || 0,
    );
    const viewportHeight = Math.max(
      1,
      innerHeight || document.documentElement.clientHeight || 0,
    );
    const canvas = await html2canvas(document.documentElement, {
      x: 0,
      y: 0,
      width: viewportWidth,
      height: viewportHeight,
      windowWidth: viewportWidth,
      windowHeight: viewportHeight,
      scrollX: 0,
      scrollY: 0,
      useCORS: true,
      allowTaint: false,
      foreignObjectRendering: true,
      scale: 1,
      logging: false,
      backgroundColor: safeBackground(background),
      onclone: (clonedDocument) => {
        const freeze = clonedDocument.createElement('style');
        freeze.textContent = '*,*::before,*::after{'
          + 'animation:none!important;transition:none!important;'
          + 'caret-color:transparent!important;}';
        clonedDocument.head.appendChild(freeze);
      },
    });
    const scale = Math.min(1, 1280 / Math.max(canvas.width, canvas.height));
    const width = Math.max(1, Math.round(canvas.width * scale));
    const height = Math.max(1, Math.round(canvas.height * scale));
    let output = canvas;
    if (scale < 1) {
      output = document.createElement('canvas');
      output.width = width;
      output.height = height;
      const context = output.getContext('2d');
      if (!context) throw new Error('浏览器未能创建截图画布');
      context.drawImage(canvas, 0, 0, width, height);
    }
    return {
      blob: await toWebp(output),
      width,
      height,
      path: logicalPreviewPath(),
    };
  };
  const captureClones = () => Array.from(
    document.querySelectorAll('iframe.html2canvas-container'),
  );
  const captureWithTimeout = (background) => {
    const existingClones = captureClones();
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanupNewClones = () => {
        for (const clone of captureClones()) {
          if (!existingClones.includes(clone)) clone.remove();
        }
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(() => {
        cleanupNewClones();
        finish(reject, new Error('预览截图渲染超时'));
      }, 8000);
      capture(background).then(
        (shot) => finish(resolve, shot),
        (error) => {
          cleanupNewClones();
          finish(reject, error);
        },
      );
    });
  };

  let captureInFlight = false;
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || event.source !== window.parent) return;
    if (data.type === 'xiaozhu-ready-request') {
      // 父页面可能在 React 状态切换期间错过首次广播；iframe load 后的握手必须可重放。
      void announceReady();
      return;
    }
    if (data.type === 'xiaozhu-nav-cmd') {
      if (data.action === 'back') history.back();
      else if (data.action === 'forward') history.forward();
      else if (data.action === 'reload') location.reload();
      return;
    }
    if (data.type !== 'xiaozhu-capture-request') return;
    const id = typeof data.id === 'string' && data.id.length <= 160 ? data.id : '';
    if (!id || data.documentId !== documentId) return;
    if (captureInFlight) {
      post('xiaozhu-capture-result', {
        id,
        ok: false,
        error: '已有截图请求正在执行',
      }, event.origin);
      return;
    }
    captureInFlight = true;
    captureWithTimeout(data.background).then(async (shot) => {
      const bytes = await shot.blob.arrayBuffer();
      post('xiaozhu-capture-result', {
        id,
        ok: true,
        bytes,
        mime: 'image/webp',
        width: shot.width,
        height: shot.height,
        path: shot.path,
      }, event.origin, [bytes]);
    }).catch((error) => {
      post('xiaozhu-capture-result', {
        id,
        ok: false,
        error: describe(error).slice(0, 500),
      }, event.origin);
    }).finally(() => {
      captureInFlight = false;
    });
  });

  const announceReady = async () => {
    try {
      // ready 表示 React 已经挂载、运行时桥可用，不代表所有远端视觉资源都已彻底稳定。
      // 视觉稳定由后续截图阶段单独等待，避免首轮未缓存资源超过父页面的 8 秒兜底。
      await waitForAppMounted();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      reportPath();
      post('xiaozhu-server-ready', {
        width: Math.max(1, innerWidth || document.documentElement.clientWidth || 0),
        height: Math.max(1, innerHeight || document.documentElement.clientHeight || 0),
      });
    } catch {}
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', announceReady, { once: true });
  } else {
    setTimeout(announceReady, 0);
  }
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
  const childEnv: Record<string, string> = {
    CI: '1',
    NODE_ENV: 'production',
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    TMPDIR: process.env.TMPDIR || '/tmp',
  }
  const proc = spawn(
    vite,
    [
      'build',
      '--config',
      path.join(jobDir, 'vite.config.ts'),
      // 默认 bundle 加载器会向 node_modules/.vite-temp 写入临时配置产物；
      // 生产镜像把固定依赖保持只读，因此改用 runner 直接执行可信配置。
      '--configLoader',
      'runner',
      '--base=./',
      '--emptyOutDir',
    ],
    {
      cwd: jobDir,
      // 不把 Worker token 等服务端密钥传进用户源码参与的 Vite 构建进程。
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const readOutput = async (stream: Readable): Promise<string> => {
    stream.setEncoding('utf8')
    let output = ''
    for await (const chunk of stream) output += chunk
    return output
  }
  const stdoutPromise = readOutput(proc.stdout)
  const stderrPromise = readOutput(proc.stderr)
  let spawnError = ''
  proc.once('error', (error) => {
    spawnError = error instanceof Error ? error.message : String(error)
  })
  const exitedPromise = new Promise<number>((resolve) => {
    proc.once('close', (code) => resolve(code ?? 1))
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { proc.kill('SIGKILL') } catch {}
  }, buildTimeoutMs)
  const code = await exitedPromise
  clearTimeout(timer)
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
  return {
    code,
    output: clipLog([spawnError, stdout, stderr].filter(Boolean).join('\n').trim()),
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

async function cachedBuildId(payload: BuildPayload): Promise<string> {
  const hasher = createHash('sha256')
  hasher.update(`xiaozhu-sandbox-build\0${BUILD_CACHE_VERSION}\0`)
  for (const filePath of [...protectedFiles].sort()) {
    let content = await readFile(path.join(templateDir, filePath), 'utf8')
    if (filePath === 'index.html') {
      content = content.replace('</head>', `${runtimeBridge()}\n</head>`)
    }
    hasher.update(`trusted\0${filePath}\0${content.length}\0${content}\0`)
  }
  for (const filePath of Object.keys(payload.files).sort()) {
    const content = payload.files[filePath]
    hasher.update(`user\0${filePath}\0${content.length}\0${content}\0`)
  }
  const hex = hasher.digest('hex')
  // 保持 UUID 形状，沿用 capability 对 build_id 的严格校验；第 13 位标记为 v5，
  // variant 固定为 RFC 4122 的 10xx。
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `a${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-')
}

async function build(payload: BuildPayload): Promise<BuildResult> {
  const buildId = await cachedBuildId(payload)
  const jobDir = path.join(jobsDir, buildId)
  const previewDir = path.join(previewsDir, payload.session_id, buildId)
  const markerPath = path.join(previewDir, '.xiaozhu-build.json')
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>
    if (marker.sessionId === payload.session_id && marker.buildId === buildId) {
      return {
        ok: true,
        build_id: buildId,
        logs: '源码未变化，复用已有构建产物',
        errors: '',
      }
    }
  } catch {
    // 没有完整缓存时正常重新构建；残缺目录会在发布新产物前清理。
  }
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
    await rm(previewDir, { recursive: true, force: true })
    await writeFile(
      path.join(jobDir, 'dist', '.xiaozhu-build.json'),
      JSON.stringify({ sessionId: payload.session_id, buildId, device: payload.device }),
      'utf8',
    )
    await rename(path.join(jobDir, 'dist'), previewDir)
    await pruneSessionPreviews(payload.session_id)
    return {
      ok: true,
      build_id: buildId,
      logs: result.output,
      errors: '',
    }
  } finally {
    await rm(jobDir, { recursive: true, force: true })
  }
}

await mkdir(jobsDir, { recursive: true })
await mkdir(previewsDir, { recursive: true })

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
    if (request.method === 'GET' && url.pathname === '/health') {
      json(response, { status: 'ok', building })
      return
    }
    if (request.method !== 'POST' || url.pathname !== '/internal/build') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }
    if (!workerToken || request.headers.authorization !== `Bearer ${workerToken}`) {
      json(response, { error: '无效 Worker 凭证' }, 401)
      return
    }
    const contentEncoding = request.headers['content-encoding']
    if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
      json(response, { error: '不支持压缩请求体' }, 415)
      return
    }
    const contentLength = Number.parseInt(request.headers['content-length'] || '0', 10)
    if (contentLength > MAX_WIRE_BYTES) {
      json(response, { error: '请求体过大' }, 413)
      return
    }
    if (building) {
      json(response, { error: '当前已有构建任务' }, 429)
      return
    }

    building = true
    try {
      let payload: BuildPayload
      try {
        payload = validatePayload(await readJsonWithLimit(request))
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          json(response, { error: error.message }, 413)
          return
        }
        json(response, { error: error instanceof Error ? error.message : String(error) }, 400)
        return
      }
      json(response, await build(payload))
    } catch (error) {
      console.error('sandbox build failed', error)
      json(response, { error: 'Worker 内部错误' }, 500)
    } finally {
      building = false
    }
  } catch (error) {
    console.error('sandbox request failed', error)
    if (!response.headersSent) json(response, { error: 'Worker 内部错误' }, 500)
    else response.end()
  }
})

server.listen(port, hostname, () => {
  console.log(`xiaozhu sandbox worker listening on ${hostname}:${port}`)
})
