import { WebContainer, type FileSystemTree } from '@webcontainer/api'
import type { FileMap } from '@/types/project'
import {
  computeDepsKey,
  getSnapshot,
  saveSnapshot,
  deleteSnapshot,
  fetchPrebuiltSnapshot,
  getWarmupPromise,
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

// ── Node 进程错误检测 ──────────────────────────────────────────
// 背景：Vite 编译错误（语法错误、import 解析失败等）只打到 dev server 的
// stdout/stderr，走上面的总线交给 xterm 渲染给人看；它【不】走浏览器 console
// （Vite 是通过 HMR websocket 推成页面红色 overlay 的，不触发 window.onerror /
// console.error），所以注入的 console bridge 抓不到，后端 agent 的
// get_browser_logs 自然也看不见——这正是「Node 报错了但 AI 没捕获到」的根因。
//
// 这里在 dev 输出流上加一层轻量检测：按行扫描、识别 Vite/esbuild/babel 的报错
// 特征行，转成结构化错误事件转发出去，由 PreviewPane 推给后端，补上这块盲区。
// 注意只做「识别 + 转发」，不接管渲染——渲染仍归 xterm。
type ServerErrorListener = (text: string) => void
const serverErrorListeners = new Set<ServerErrorListener>()

/** 订阅 Node 进程（Vite）编译错误。返回取消订阅函数。 */
export function subscribeServerErrors(listener: ServerErrorListener): () => void {
  serverErrorListeners.add(listener)
  return () => serverErrorListeners.delete(listener)
}

// 去掉 ANSI 转义序列（颜色 / 光标控制 / OSC），只留可读文本，方便匹配与回传。
function stripAnsi(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
}

// 编译错误的特征行：命中其一即认为这一行是报错。覆盖 Vite 插件报错、
// dev server 内部错误、esbuild/babel 语法错误、模块解析失败等常见形态。
const SERVER_ERROR_RE =
  /(\[vite\][^\n]*(error|failed))|\[plugin:[^\]]+\]|internal server error|pre-transform error|transform failed|failed to (load|resolve|parse|compile)|unexpected token/i

// 行缓冲：raw chunk 可能在任意位置（甚至一行中间）截断，攒到换行再判断整行。
let errLineBuf = ''

/** 把一段 dev 原始输出喂进错误检测器，命中报错行就通知订阅者。 */
function scanForServerErrors(rawChunk: string): void {
  errLineBuf += stripAnsi(rawChunk)
  const lines = errLineBuf.split('\n')
  // 最后一段可能是被截断的半行，留到下一个 chunk 再拼。
  errLineBuf = lines.pop() ?? ''
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || !SERVER_ERROR_RE.test(line)) continue
    // WebContainer 里文件是绝对路径（/home/<随机>/src/...），但 agent 认的是
    // 相对路径（src/...）。去掉这段前缀，报错里的路径才能和文件树对上。
    const normalized = line.replace(/\/home\/[^/\s]+\//g, '')
    for (const fn of serverErrorListeners) {
      try {
        fn(normalized)
      } catch (e) {
        console.error('server error listener error', e)
      }
    }
  }
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

// ── 路由导航桥接脚本 ──────────────────────────────────────────
// 同样注入到 iframe 的 index.html，解决「预览跨域，父页面读不到 iframe 的 URL」：
// - 业务代码（React Router）切换路由走的是 history.pushState / replaceState，
//   这里把这两个方法包一层，切换后用 postMessage 把新路径报给父页面（地址栏要显示）；
// - 监听 popstate / hashchange，浏览器前进后退时同样上报；
// - 反向：监听父页面发来的 vibuild-nav-cmd 指令，在 iframe 内执行
//   history.back() / forward() / location.reload()（这些跨域只能由 iframe 自己调）。
// 必须先于业务代码执行，所以和 console 桥一样放 <head> 末尾。
//
// 设计要点：
// - __vibuildNavBridged 旗标避免 HMR 重新执行时重复包裹 history 方法
// - kind 标明这次是 push / replace / pop / init，父页面据此维护前进后退栈
const NAV_BRIDGE_SCRIPT = `<script>(function(){
  if (window.__vibuildNavBridged) return;
  window.__vibuildNavBridged = true;
  function cur(){ return location.pathname + location.search + location.hash; }
  function report(kind){
    try { window.parent.postMessage({ type: 'vibuild-nav', kind: kind, path: cur() }, '*'); } catch(e) {}
  }
  var _push = history.pushState;
  history.pushState = function(){ var r = _push.apply(this, arguments); report('push'); return r; };
  var _replace = history.replaceState;
  history.replaceState = function(){ var r = _replace.apply(this, arguments); report('replace'); return r; };
  window.addEventListener('popstate', function(){ report('pop'); });
  window.addEventListener('hashchange', function(){ report('pop'); });
  window.addEventListener('message', function(e){
    var d = e.data;
    if (!d || d.type !== 'vibuild-nav-cmd') return;
    if (d.action === 'back') history.back();
    else if (d.action === 'forward') history.forward();
    else if (d.action === 'reload') location.reload();
  });
  // 首次上报当前地址（DOM 就绪后，确保是业务代码可能重定向前的初始态）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function(){ report('init'); });
  } else {
    report('init');
  }
})();</script>`

// ── Vite 编译错误 overlay 监测脚本 ─────────────────────────────
// 为什么单独搞这个：Vite 把编译错误（语法错误、import 解析失败等）以
// <vite-error-overlay> 自定义元素注入 iframe 的 document.body，渲染成那块红屏。
// 它【不】走 console，所以 console 桥抓不到；它也【不】每轮都重新打印到 dev server
// 的 stdout —— 一个本轮没被改动的坏文件，Vite 增量编译不会重新 transform 它，
// 它的报错就永远停在"上一次"的日志里。于是会出现这种最常见的自检漏报：
//   AI 修好了 A 文件 → update_preview → get_browser_logs 只看到"屏障之后没有新报错"
//   → 误判"运行正常" → 可 B 文件其实一直红着，用户看到的预览仍是红屏。
//
// 这块红屏 overlay 才精确等于"用户此刻看到的报错状态"。所以这里直接盯它：
// 出现/消失时上报，并支持父页面在"应用新代码到预览"后主动 recheck，把当前红屏态
// 重新汇报一遍 —— 哪怕坏文件本轮没被碰过，自检也能知道"预览还红着"。
const OVERLAY_BRIDGE_SCRIPT = `<script>(function(){
  if (window.__vibuildOverlayBridged) return;
  window.__vibuildOverlayBridged = true;
  var lastKey = '';  // 上次上报的状态签名，仅在状态变化时 post，避免刷屏
  function readOverlay(){
    var el = document.querySelector('vite-error-overlay');
    if (!el) return { present: false, text: '' };
    var text = '';
    try {
      var root = el.shadowRoot || el;
      var parts = ['.message-body', '.message', '.file', '.frame'];
      for (var i=0;i<parts.length;i++){
        var n = root.querySelector(parts[i]);
        if (n && n.textContent) text += n.textContent + '\\n';
      }
      if (!text) text = el.textContent || 'Vite 编译错误';
    } catch(e) { text = 'Vite 编译错误'; }
    return { present: true, text: text.replace(/\\s+/g,' ').trim().slice(0, 2000) };
  }
  function report(force){
    var s = readOverlay();
    var key = s.present ? ('1|' + s.text) : '0';
    if (!force && key === lastKey) return;
    lastKey = key;
    try { window.parent.postMessage({ type: 'vibuild-vite-overlay', present: s.present, text: s.text }, '*'); } catch(e) {}
  }
  // overlay 是 body 的直接子节点，监听 body 的 childList 即可捕获它的增删（性能也好）。
  var mo = new MutationObserver(function(){ report(false); });
  function startObserve(){
    try { mo.observe(document.body, { childList: true }); } catch(e){}
    report(true);
  }
  if (document.body) startObserve();
  else document.addEventListener('DOMContentLoaded', startObserve);
  // 父页面在"揭晓新代码到预览"后会发 recheck：强制重报当前红屏态（即便 overlay 没增删），
  // 用来覆盖"本轮没改动、但仍红屏的文件"——它的错误不会重新进日志流，只能靠主动重报。
  window.addEventListener('message', function(e){
    var d = e.data;
    if (d && d.type === 'vibuild-recheck') report(true);
  });
})();</script>`

/** 把一段脚本注入 index.html 的 <head> 末尾（没有 </head> 就放 <body> 前）。
 *  flag 用于幂等判断：html 里已含该标记就跳过，避免重复注入。 */
function injectScript(files: FileMap, script: string, flag: string): FileMap {
  const html = files['index.html']
  if (!html) return files
  if (html.includes(flag)) return files  // 已注入过
  const next = html.includes('</head>')
    ? html.replace('</head>', `  ${script}\n  </head>`)
    : html.replace('<body>', `${script}\n<body>`)
  return { ...files, 'index.html': next }
}

/** 把 console 桥 + 路由导航桥都注入到 index.html（幂等）。
 *  两处脚本互相独立，分别用各自的旗标判断是否已注入。 */
function injectConsoleBridge(files: FileMap): FileMap {
  let next = injectScript(files, CONSOLE_BRIDGE_SCRIPT, '__vibuildConsoleBridged')
  next = injectScript(next, NAV_BRIDGE_SCRIPT, '__vibuildNavBridged')
  next = injectScript(next, OVERLAY_BRIDGE_SCRIPT, '__vibuildOverlayBridged')
  return next
}

// ── .bin 软链接重建脚本 ────────────────────────────────────────
// 背景：wc.export(binary) 导出的快照不保存符号链接，所以 mount 回来后
// node_modules/.bin 整个是空的（vite / tsc 等命令全靠这里的软链接定位）。
// 实测 `npm rebuild` 在 WebContainer 里报成功却不重建 .bin，不可靠。
// 改成自己干：遍历 node_modules 里每个包的 package.json，读 bin 字段，
// 在 .bin/ 下补回软链接。纯本地磁盘操作、不联网。
//
// 这段在容器内的 Node 里跑（前端 fs API 没暴露 symlink，但容器里的 node 有）。
const RELINK_BIN_SCRIPT = `
const fs = require('fs');
const path = require('path');
const root = 'node_modules';
const binDir = path.join(root, '.bin');
fs.mkdirSync(binDir, { recursive: true });

// 收集待处理的包目录：顶层包 + @scope/ 下的包
const pkgDirs = [];
for (const name of fs.readdirSync(root)) {
  if (name === '.bin' || name.startsWith('.')) continue;
  if (name.startsWith('@')) {
    // scope 目录，再下一层才是真正的包
    const scopeDir = path.join(root, name);
    if (!fs.statSync(scopeDir).isDirectory()) continue;
    for (const sub of fs.readdirSync(scopeDir)) {
      pkgDirs.push(path.join(scopeDir, sub));
    }
  } else {
    const dir = path.join(root, name);
    if (fs.statSync(dir).isDirectory()) pkgDirs.push(dir);
  }
}

let linked = 0;
for (const dir of pkgDirs) {
  const pkgFile = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgFile)) continue;
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')); } catch { continue; }
  let bin = pkg.bin;
  if (!bin) continue;
  // bin 可能是字符串（命令名=去 scope 的包名）或对象 {命令名: 相对路径}
  if (typeof bin === 'string') {
    const cmd = pkg.name && pkg.name.startsWith('@') ? pkg.name.split('/')[1] : pkg.name;
    bin = { [cmd]: bin };
  }
  for (const [cmd, rel] of Object.entries(bin)) {
    const target = path.join(dir, rel);                 // 真实可执行文件
    const linkPath = path.join(binDir, cmd);            // .bin 下的链接
    // 软链接内容用「相对 .bin 目录」的路径，跟 npm 行为一致
    const relTarget = path.relative(binDir, target);
    try {
      if (fs.existsSync(linkPath) || fs.lstatSync(linkPath, { throwIfNoEntry: false })) {
        fs.rmSync(linkPath, { force: true });
      }
    } catch {}
    try {
      fs.symlinkSync(relTarget, linkPath);
      try { fs.chmodSync(target, 0o755); } catch {}     // 确保目标可执行
      linked++;
    } catch (e) {
      console.error('link failed', cmd, e.message);
    }
  }
}
console.log('relinked ' + linked + ' bin entries');
`

/** 把一个进程的输出转发到总线，并在 UI 上贴个分隔横幅。
 *  banner 让用户知道"现在是在 install 阶段还是 dev 阶段"。 */
function pipeRawToBus(
  output: ReadableStream<string>,
  banner: string,
  // scanErrors：是否额外把输出喂给错误检测器（只有常驻的 dev server 需要，
  // install / relink / build 那些一次性进程靠 exit code 判断成败，不必扫）。
  opts?: { scanErrors?: boolean },
) {
  // \r\n 是 xterm 期望的换行；颜色码让 banner 醒目些
  broadcast(`\x1b[36m\r\n— ${banner} —\x1b[0m\r\n`)
  return output.pipeTo(
    new WritableStream({
      write(chunk) {
        const s = chunk.toString()
        broadcast(s)
        if (opts?.scanErrors) scanForServerErrors(s)
      },
    }),
  )
}

/**
 * 把一份二进制 node_modules 快照挂回容器，并重建 .bin 软链接。
 * 两级缓存（IndexedDB 快照 / 预置静态快照）共用这套挂载逻辑。
 * 成功返回 true；任一步失败抛错，由调用方决定 fallback。
 */
async function mountSnapshotAndRelink(
  wc: WebContainer,
  snapshot: Uint8Array,
): Promise<void> {
  // mount 的挂载点目录必须先存在，否则 mount 会静默失败（数据不写入也不报错）。
  // 项目模板里没有 node_modules，所以这里先建出来。
  await wc.fs.mkdir('node_modules', { recursive: true })
  // 注意：wc.mount 对二进制快照走 Transferable 机制——会「转移」而非拷贝传入 buffer，
  // 转移后调用方手里的 snapshot 会变成 detached 空壳。这里克隆一份再 mount，
  // 保证传入的 snapshot 始终完好，调用方可放心复用（如随后写回 IndexedDB）。
  await wc.mount(snapshot.slice(), { mountPoint: 'node_modules' })
  // 快照往返会丢失 node_modules/.bin 下的符号链接（vite 等命令靠它定位，
  // 否则 npm run dev 会报 "command not found: vite"）。
  // 不用 npm rebuild —— 它在 WebContainer 里报成功却不重建 .bin。
  // 改成自己跑脚本遍历各包 package.json 的 bin 字段、补回软链接，纯本地不联网。
  broadcast('\x1b[36m\r\n— 重建 .bin 软链接 —\x1b[0m\r\n')
  const relink = await wc.spawn('node', ['-e', RELINK_BIN_SCRIPT])
  pipeRawToBus(relink.output, 'relink bin')
  const relinkCode = await relink.exit
  if (relinkCode !== 0) {
    throw new Error(`重建 .bin 失败 (exit ${relinkCode})`)
  }
  // 校验 .bin 确实链好了：dev server 是常驻进程不 await，
  // 这里不拦住的话，命令缺失只会在终端报 "command not found"。
  const bin = await wc.fs.readdir('node_modules/.bin').catch(() => [] as string[])
  if (bin.length === 0) {
    throw new Error('node_modules/.bin 为空，bin 链接未恢复')
  }
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
      // ── 第一级：IndexedDB 快照（老用户，最快，纯本地无网络）──
      const snapshot = await getSnapshot(depsKey)
      if (snapshot) {
        try {
          hooks.onLog('从缓存恢复依赖')
          broadcast('\x1b[36m\r\n— 从缓存恢复 node_modules —\x1b[0m\r\n')
          await mountSnapshotAndRelink(wc, snapshot)
          restored = true
        } catch (e) {
          // 恢复失败：删掉这份损坏快照，继续往下尝试预置快照 / npm install
          const reason = e instanceof Error ? e.message : String(e)
          broadcast(`\x1b[31m\r\n[diag] IndexedDB 快照恢复失败：${reason}\x1b[0m\r\n`)
          console.warn('IndexedDB 快照恢复失败', e)
          await deleteSnapshot(depsKey)
          restored = false
        }
      }

      // ── 第二级：预置静态快照（新用户首次兜底，fetch 自家 CDN，与 npm registry 无关）──
      if (!restored) {
        // 预热可能还在后台下载同一个文件；先等它结束再查 IndexedDB，
        // 命中则直接用，避免重复发起 13MB 下载
        const warmup = getWarmupPromise()
        if (warmup) {
          broadcast('\x1b[36m\r\n— 等待后台预热完成 —\x1b[0m\r\n')
          await warmup.catch(() => {})  // 预热失败无所谓，下面照常走
          const cached = await getSnapshot(depsKey)
          if (cached) {
            try {
              hooks.onLog('从预热缓存恢复依赖')
              broadcast('\x1b[36m\r\n— 从预热缓存恢复 node_modules —\x1b[0m\r\n')
              await mountSnapshotAndRelink(wc, cached)
              restored = true
            } catch (e) {
              const reason = e instanceof Error ? e.message : String(e)
              broadcast(`\x1b[31m\r\n[diag] 预热缓存恢复失败：${reason}\x1b[0m\r\n`)
              await deleteSnapshot(depsKey)
            }
          }
        }
      }

      if (!restored) {
        const prebuilt = await fetchPrebuiltSnapshot(depsKey)
        if (prebuilt) {
          try {
            hooks.onLog('从预置快照恢复依赖')
            broadcast('\x1b[36m\r\n— 从预置快照恢复 node_modules —\x1b[0m\r\n')
            await mountSnapshotAndRelink(wc, prebuilt)
            restored = true
            // 命中预置快照后写入本地 IndexedDB，让该用户下次走最快的第一级
            try {
              await saveSnapshot(depsKey, prebuilt)
            } catch (e) {
              console.warn('预置快照写入 IndexedDB 失败（不影响运行）', e)
            }
          } catch (e) {
            const reason = e instanceof Error ? e.message : String(e)
            broadcast(`\x1b[31m\r\n[diag] 预置快照恢复失败：${reason}\x1b[0m\r\n`)
            console.warn('预置快照恢复失败', e)
            restored = false
          }
        }
      }
    }

    if (!restored) {
      // ── 第三级：正常 npm install（前两级都未命中时的兜底）──
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
    // dev server 的输出要扫错误：Vite 编译报错只在这条流里，扫出来回传后端
    // 才能让 agent 的 get_browser_logs 看到。
    pipeRawToBus(dev.output, 'npm run dev', { scanErrors: true })

    // server-ready 时先预热 Vite，再通知 UI 显示 iframe
    // 原因：server-ready 只代表端口开了，Vite 第一次处理请求时才做 esbuild
    // pre-bundling（约 2-5s）。若直接显示 iframe，用户会看到白屏等 Vite 预打包。
    // 改成在容器内自己 fetch 一次触发预打包，完成后 iframe 打开即是热的状态。
    wc.on('server-ready', async (port, url) => {
      broadcast('\x1b[36m\r\n— 预热 Vite（首次依赖预打包）—\x1b[0m\r\n')
      try {
        const warmup = await wc.spawn('node', [
          '-e',
          `require('http').get('http://localhost:${port}/',r=>{r.resume();r.on('end',()=>process.exit(0));}).on('error',()=>process.exit(0));`,
        ])
        await warmup.exit
      } catch {
        // 预热失败不阻塞，顶多白屏一下
      }
      hooks.onUrl(url)
      hooks.onStatus('ready')
      hooks.onLog('dev server ready')
    })
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

// ── 构建产物（分享用）─────────────────────────────────────────
// 分享流程：在分享者自己的容器里 `vite build` 出 dist，把它读出来上传给后端，
// 访客打开链接时后端把 dist 当静态站点直接发出去，秒开、不碰 WebContainer。

/** 一个构建产物文件。二进制（图片/字体）用 base64 编码，由 isBase64 标记。 */
export type BuiltFile = { path: string; content: string; isBase64: boolean }

// 按扩展名判断「文本文件」——这些直接存原文，其余按二进制 base64 处理
const TEXT_EXTS = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'json', 'svg', 'txt',
  'map', 'xml', 'webmanifest',
])

function isTextPath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return TEXT_EXTS.has(ext)
}

/** 把字节数组转 base64（分块处理，避免大文件一次性 apply 撑爆调用栈）。 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** 递归列出某目录下所有文件的完整路径。 */
async function listFilesRecursive(wc: WebContainer, dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await wc.fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = `${dir}/${e.name}`
    if (e.isDirectory()) {
      out.push(...await listFilesRecursive(wc, full))
    } else {
      out.push(full)
    }
  }
  return out
}

/**
 * 在当前容器里构建出 dist，并把它读成一组文件返回（供上传分享）。
 *
 * 直接调 `vite build --base=./` 而不是 `npm run build`：
 *   - 模板的 build 脚本是 `tsc && vite build`，AI 生成的代码常有类型报错，
 *     tsc 会直接中断构建。分享只要能跑起来的产物，不该被类型检查卡住。
 *   - `--base=./` 让产物用相对路径引资源，才能被挂在 /shared/{token}/ 子路径下正常加载。
 */
export async function buildDist(hooks?: { onLog?: (line: string) => void }): Promise<BuiltFile[]> {
  const wc = await getContainer()
  hooks?.onLog?.('vite build')
  const build = await wc.spawn('npx', ['vite', 'build', '--base=./'])
  pipeRawToBus(build.output, 'vite build (分享)')
  const code = await build.exit
  if (code !== 0) {
    throw new Error(`构建失败 (exit ${code})，请确认项目能正常构建`)
  }

  const paths = await listFilesRecursive(wc, 'dist')
  if (paths.length === 0) {
    throw new Error('构建产物为空（dist 没有文件）')
  }

  const files: BuiltFile[] = []
  for (const full of paths) {
    const rel = full.replace(/^dist\//, '')  // 去掉 dist/ 前缀，存相对路径
    if (isTextPath(rel)) {
      const content = await wc.fs.readFile(full, 'utf-8')
      files.push({ path: rel, content, isBase64: false })
    } else {
      const bytes = await wc.fs.readFile(full)
      files.push({ path: rel, content: bytesToBase64(bytes), isBase64: true })
    }
  }
  hooks?.onLog?.(`dist 读取完成，共 ${files.length} 个文件`)
  return files
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
  // 清掉错误检测器的半行缓冲，避免上个项目残留的半行和新项目拼成假报错。
  errLineBuf = ''
  // 清空日志回放缓冲，并给已挂载的 xterm 发「清屏 + 清回滚」指令，
  // 否则上个项目的 npm / dev 日志会一直留在终端里。
  history = ''
  broadcast('\x1b[2J\x1b[3J\x1b[H')
}

// ── 开发者工具：导出预置快照 ───────────────────────────────────
// 用法（仅开发期，在浏览器 console 里）：先正常打开一个项目、等它跑起来
// （此时容器内 node_modules 已装好），然后执行 `window.__vibuildExportPrebuilt()`。
// 它会下载两个文件：
//   deps-snapshot.bin   —— 当前容器 node_modules 的二进制快照
//   deps-snapshot.json  —— manifest（含 depsKey，运行时用于校验是否匹配）
// 把这两个文件放进 web/public/ 提交，新用户首次即可走「预置快照」级、不再联网安装。
//
// 为什么从「实时容器」导出而不是从 IndexedDB？
//   实时容器里的 node_modules 是 npm 在 WebContainer 环境里亲手装的，平台二进制
//   （esbuild/vite 等）一定正确；导出路径也和运行时恢复完全一致，最可靠。
async function exportPrebuiltSnapshot(): Promise<void> {
  if (!containerPromise) {
    console.error('[导出] 容器尚未 boot，请先打开一个项目并等它跑起来')
    return
  }
  const wc = await containerPromise
  // 读容器里的 package.json 算 depsKey，确保与运行时 computeDepsKey 口径一致
  const pkgJson = await wc.fs.readFile('package.json', 'utf-8').catch(() => undefined)
  const depsKey = await computeDepsKey(pkgJson)
  if (!depsKey) {
    console.error('[导出] 无法计算 depsKey（读不到 package.json？）')
    return
  }
  console.log('[导出] 正在导出 node_modules 快照…（66MB 左右，稍候）')
  const snapshot = await wc.export('node_modules', { format: 'binary' })

  // 触发浏览器下载的小工具
  const download = (data: BlobPart, filename: string, type: string) => {
    const url = URL.createObjectURL(new Blob([data], { type }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }
  // wc.export 返回的 Uint8Array 其 buffer 在 COEP 环境下可能被推断为 SharedArrayBuffer，
  // Blob 不接受；slice 出一份普通 ArrayBuffer 副本即可。
  download(snapshot.slice().buffer as ArrayBuffer, 'deps-snapshot.bin', 'application/octet-stream')
  download(JSON.stringify({ depsKey }, null, 2), 'deps-snapshot.json', 'application/json')
  console.log(`[导出] 完成。depsKey=${depsKey}，请把两个文件放进 web/public/ 提交。`)
}

// 挂到 window 供 console 调用（仅开发期用，不进任何 UI）
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__vibuildExportPrebuilt = exportPrebuiltSnapshot
}
