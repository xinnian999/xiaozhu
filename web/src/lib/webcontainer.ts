import { WebContainer, type FileSystemTree } from '@webcontainer/api'
import type { FileMap } from '@/types/project'
import {
  computeDepsKey,
  getSnapshot,
  saveSnapshot,
  deleteSnapshot,
} from '@/lib/depsCache'

// ============================================
// WebContainer 单例封装
// ============================================
// - 整页只能 boot 一次，再次 boot 会抛错，所以用模块级单例
// - 暴露 boot/install/dev/syncFiles 四个高层动作
// - 通过事件回调把状态变化报告给上层，避免循环依赖 store
//
// 关于 node 进程输出：我们不再自己解析 ANSI / 拆行，那条路坑太多
// （进度条、清屏、跨 chunk 拼接……）。改成把 raw 字节流转发出去，
// 由 xterm.js 负责渲染 —— 它本来就是终端模拟器。
//
// 订阅模型：进程输出 → 写入 ringBuffer + 通知 listeners。
// 终端组件挂载时 attach(listener)：先重放 ringBuffer 把历史补齐，再实时收新数据。

let containerPromise: Promise<WebContainer> | null = null
let devServerStarted = false
let lastFiles: FileMap | null = null  // 上次 mount 的文件快照，用于增量 diff

// ── 输出广播总线 ───────────────────────────────────────────────
// 所有 node 进程的 stdout/stderr 都汇入这一个总线。
// xterm 视角下不区分 install / dev —— 那只是同一个 shell 的不同阶段，
// 统一显示就是真实的终端体验。
type OutputListener = (chunk: string) => void
const listeners = new Set<OutputListener>()
// 历史缓冲：保留最近若干字节，新订阅者可以拿到一份回放
const HISTORY_BYTES = 64 * 1024
let history = ''

function broadcast(chunk: string) {
  // 追加到历史，超长就截掉前面
  history += chunk
  if (history.length > HISTORY_BYTES) {
    history = history.slice(history.length - HISTORY_BYTES)
  }
  for (const fn of listeners) {
    try {
      fn(chunk)
    } catch (e) {
      console.error('output listener error', e)
    }
  }
}

/** 订阅 node 进程输出。返回取消订阅函数。
 *  订阅时立即回调一次历史 buffer，确保新挂载的终端不会"丢前面的日志"。 */
export function subscribeProcessOutput(listener: OutputListener): () => void {
  if (history) listener(history)
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 启动（首次调用真正 boot，之后返回同一个实例） */
export function getContainer(): Promise<WebContainer> {
  if (!containerPromise) {
    containerPromise = WebContainer.boot()
  }
  return containerPromise
}

/** 把扁平 FileMap 转成 WebContainer 需要的嵌套树结构 */
function toFileTree(files: FileMap): FileSystemTree {
  const tree: FileSystemTree = {}
  for (const [path, contents] of Object.entries(files)) {
    const parts = path.split('/')
    let cursor: FileSystemTree = tree
    parts.forEach((seg, i) => {
      const isFile = i === parts.length - 1
      if (isFile) {
        cursor[seg] = { file: { contents } }
      } else {
        // 目录节点
        if (!cursor[seg] || !('directory' in cursor[seg])) {
          cursor[seg] = { directory: {} }
        }
        cursor = (cursor[seg] as { directory: FileSystemTree }).directory
      }
    })
  }
  return tree
}

// ── 浏览器 console 桥接脚本 ────────────────────────────────────
// 注入到 iframe 内的 index.html 里：拦截 console.* + 全局错误事件，
// 通过 postMessage 把日志转发给父页面（即我们的 UI）。
// 必须先于业务代码执行，所以放在 <head> 末尾。
//
// 设计要点：
// - 用 __vibuildConsoleBridged 旗标避免重复绑定（HMR 重新执行时）
// - args 序列化要兜底，遇到 Error / 循环引用都不能抛
// - 不挡 console 原行为：调完 post 后照常调原方法
const CONSOLE_BRIDGE_SCRIPT = `<script>(function(){
  if (window.__vibuildConsoleBridged) return;
  window.__vibuildConsoleBridged = true;
  function stringify(a){
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object' && a !== null) {
      try { return JSON.stringify(a); } catch(e) { return String(a); }
    }
    return String(a);
  }
  function post(level, args){
    try {
      window.parent.postMessage({
        type: 'vibuild-console',
        level: level,
        text: Array.prototype.map.call(args, stringify).join(' ')
      }, '*');
    } catch(e) {}
  }
  ['log','info','warn','error','debug'].forEach(function(lvl){
    var orig = console[lvl];
    console[lvl] = function(){ post(lvl === 'debug' ? 'log' : lvl, arguments); orig.apply(console, arguments); };
  });
  window.addEventListener('error', function(e){
    post('error', [e.message + ' (' + (e.filename||'') + ':' + e.lineno + ')']);
  });
  window.addEventListener('unhandledrejection', function(e){
    post('error', ['Unhandled rejection: ' + stringify(e.reason)]);
  });
})();</script>`

/** 把 console bridge 注入到 index.html 里（如果还没注入） */
function injectConsoleBridge(files: FileMap): FileMap {
  const html = files['index.html']
  if (!html) return files
  if (html.includes('__vibuildConsoleBridged')) return files  // 已注入过
  // 优先放在 <head> 结束前；没有 </head> 就放在 <body> 前
  const next = html.includes('</head>')
    ? html.replace('</head>', `  ${CONSOLE_BRIDGE_SCRIPT}\n  </head>`)
    : html.replace('<body>', `${CONSOLE_BRIDGE_SCRIPT}\n<body>`)
  return { ...files, 'index.html': next }
}

/** 把一个进程的输出转发到总线，并在 UI 上贴个分隔横幅。
 *  banner 让用户知道"现在是在 install 阶段还是 dev 阶段"。 */
function pipeRawToBus(
  output: ReadableStream<string>,
  banner: string,
) {
  // \r\n 是 xterm 期望的换行；颜色码让 banner 醒目些
  broadcast(`\x1b[36m\r\n— ${banner} —\x1b[0m\r\n`)
  return output.pipeTo(
    new WritableStream({
      write(chunk) {
        broadcast(chunk.toString())
      },
    }),
  )
}

/** 全量 mount（首次启动 + npm install + dev server） */
export async function bootAndRun(
  files: FileMap,
  hooks: {
    onStatus: (s: 'booting' | 'mounting' | 'installing' | 'starting' | 'ready' | 'error') => void
    onUrl: (url: string) => void
    onLog: (line: string) => void
    onError: (msg: string) => void
  },
): Promise<void> {
  try {
    hooks.onStatus('booting')
    const wc = await getContainer()

    hooks.onStatus('mounting')
    // 把 console bridge 脚本注入到 index.html，让 iframe 里的业务代码 console
    // 都能被父页面收到
    const filesWithBridge = injectConsoleBridge(files)
    await wc.mount(toFileTree(filesWithBridge))
    lastFiles = { ...filesWithBridge }

    // 监听后续 server-ready 事件（dev 启动后 vite 端口 ready 时触发）
    wc.on('server-ready', (_port, url) => {
      hooks.onUrl(url)
      hooks.onStatus('ready')
      hooks.onLog('dev server ready')
    })

    // 依赖安装：先尝试从 IndexedDB 缓存恢复 node_modules，命中则跳过 npm install
    hooks.onStatus('installing')
    // 依赖哈希作为缓存 key —— 模板固定 → 哈希恒定 → 跨项目/刷新共享同一份依赖
    const depsKey = await computeDepsKey(filesWithBridge['package.json'])
    let restored = false

    if (depsKey) {
      const snapshot = await getSnapshot(depsKey)
      if (snapshot) {
        try {
          // 把缓存的快照秒挂到 node_modules，省掉整轮网络安装
          hooks.onLog('从缓存恢复依赖')
          broadcast('\x1b[36m\r\n— 从缓存恢复 node_modules —\x1b[0m\r\n')
          await wc.mount(snapshot, { mountPoint: 'node_modules' })
          // 快照往返会丢失 node_modules/.bin 下的符号链接（vite 等命令靠它定位，
          // 否则 npm run dev 会报 "command not found: vite"）。
          // npm rebuild 会重建 .bin —— 纯磁盘操作、不联网。
          // --ignore-scripts：跳过各包的 install/postinstall 脚本（其产物已在快照里，
          // 重跑纯属浪费），只保留 bin 链接这步，省掉大半耗时。
          const rebuild = await wc.spawn('npm', ['rebuild', '--ignore-scripts'])
          pipeRawToBus(rebuild.output, 'npm rebuild')
          const rebuildCode = await rebuild.exit
          if (rebuildCode !== 0) {
            throw new Error(`npm rebuild 失败 (exit ${rebuildCode})`)
          }
          // 校验 .bin 确实链好了：dev server 是常驻进程不 await，
          // 这里不拦住的话，命令缺失只会在终端报 "command not found"。
          const bin = await wc.fs.readdir('node_modules/.bin').catch(() => [] as string[])
          if (bin.length === 0) {
            throw new Error('node_modules/.bin 为空，bin 链接未恢复')
          }
          restored = true
        } catch (e) {
          // 恢复链路任一步失败：删掉这份快照，退回干净的网络安装
          console.warn('依赖快照恢复失败，退回 npm install', e)
          await deleteSnapshot(depsKey)
          restored = false
        }
      }
    }

    if (!restored) {
      // 缓存未命中（或恢复失败）：正常 npm install
      hooks.onLog('npm install')
      const install = await wc.spawn('npm', ['install'])
      pipeRawToBus(install.output, 'npm install')
      const installCode = await install.exit
      if (installCode !== 0) {
        throw new Error(`npm install 失败 (exit ${installCode})`)
      }
      // 安装成功后导出 node_modules 快照存入缓存，供下次秒开（best-effort，失败不影响运行）
      if (depsKey) {
        try {
          const snapshot = await wc.export('node_modules', { format: 'binary' })
          await saveSnapshot(depsKey, snapshot)
        } catch (e) {
          console.warn('依赖快照导出失败（不影响本次运行）', e)
        }
      }
    }

    // npm run dev
    hooks.onStatus('starting')
    hooks.onLog('npm run dev')
    const dev = await wc.spawn('npm', ['run', 'dev'])
    devServerStarted = true
    pipeRawToBus(dev.output, 'npm run dev')
    // 不 await dev.exit —— 它是常驻进程
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    hooks.onError(msg)
    hooks.onStatus('error')
  }
}

/** 计算 diff，将变化文件增量写入容器；不重启 dev server，依赖 vite HMR */
export async function syncFiles(
  files: FileMap,
  hooks: { onLog: (line: string) => void },
): Promise<{ added: number; modified: number; removed: number }> {
  const wc = await getContainer()
  // 同步阶段也确保 index.html 始终带 bridge —— 否则 LLM 改 html 会把它覆盖掉
  const filesWithBridge = injectConsoleBridge(files)
  const prev = lastFiles ?? {}

  let added = 0
  let modified = 0
  let removed = 0

  // 新增 + 修改
  for (const [path, content] of Object.entries(filesWithBridge)) {
    if (!(path in prev)) {
      added++
    } else if (prev[path] !== content) {
      modified++
    } else {
      continue
    }
    // 父目录可能尚未存在，先 mkdir -p
    const dir = path.split('/').slice(0, -1).join('/')
    if (dir) {
      try {
        await wc.fs.mkdir(dir, { recursive: true })
      } catch {
        // 已存在则忽略
      }
    }
    await wc.fs.writeFile(path, content)
  }

  // 删除
  for (const path of Object.keys(prev)) {
    if (!(path in filesWithBridge)) {
      try {
        await wc.fs.rm(path)
        removed++
      } catch {
        // 文件可能已不存在
      }
    }
  }

  lastFiles = { ...filesWithBridge }
  hooks.onLog(`synced +${added} ~${modified} -${removed}`)

  return { added, modified, removed }
}

/** 当前是否已 boot（用于决定走全量还是增量） */
export function isBooted(): boolean {
  return containerPromise !== null
}

/** dev server 是否已起来（用于决定是否要走完整 install/dev 流程） */
export function isDevRunning(): boolean {
  return devServerStarted
}

/**
 * 销毁当前容器并清空所有单例状态，为下一个项目腾位。
 * 切 / 开会话时调用 —— WebContainer 明确「同一时刻只能有一个实例」，
 * 必须先 teardown 才能重新 boot，否则上个项目的 FS / dev server / 终端日志
 * 都会残留串台。teardown 后所有派生对象（进程、fs…）即失效。
 */
export async function resetContainer(): Promise<void> {
  if (containerPromise) {
    try {
      const wc = await containerPromise
      wc.teardown()
    } catch (e) {
      // teardown 失败不致命：清掉引用，让下次重新 boot
      console.warn('容器 teardown 失败（忽略）', e)
    }
  }
  containerPromise = null
  devServerStarted = false
  lastFiles = null
  // 清空日志回放缓冲，并给已挂载的 xterm 发「清屏 + 清回滚」指令，
  // 否则上个项目的 npm / dev 日志会一直留在终端里。
  history = ''
  broadcast('\x1b[2J\x1b[3J\x1b[H')
}
