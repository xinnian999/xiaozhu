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
// dist 产物的持久化缓存（L2）。内存 Map（L1，见下）刷新即丢，这层落 IndexedDB、跨刷新存活。
import { getDist, putDist } from '@/lib/distCache'

// ============================================
// WebContainer 单例封装
// ============================================
// - 整页只能 boot 一次，再次 boot 会抛错，所以用模块级单例
// - 预览方案：`vite build` 出 dist → `vite preview` 起静态服务预览。
//   每次揭晓都全量构建（无 HMR），「编译过没过」就是构建退出码，确定、好抓，
//   且和「分享」走同一条 build 路径，所见即所分享。
// - 通过事件回调把状态变化报告给上层，避免循环依赖 store
//
// 关于 node 进程输出：我们不再自己解析 ANSI / 拆行，那条路坑太多
// （进度条、清屏、跨 chunk 拼接……）。改成把 raw 字节流转发出去，
// 由 xterm.js 负责渲染 —— 它本来就是终端模拟器。
//
// 订阅模型：进程输出 → 写入 ringBuffer + 通知 listeners。
// 终端组件挂载时 attach(listener)：先重放 ringBuffer 把历史补齐，再实时收新数据。

let containerPromise: Promise<WebContainer> | null = null
let previewStarted = false  // vite preview 静态服务是否已起来
let lastFiles: FileMap | null = null  // 上次 mount 的文件快照，用于增量 diff

// 本浏览器会话里是否已经成功 boot 过一次。用于给「冷/热 boot」打标：
//   - 冷 boot：会话内首次成功前的 boot，运行时（~470KB/3.9MB）和依赖都还没缓存，最慢；
//   - 热 boot：之后（切项目）的重 boot，运行时多半已进 HTTP 缓存、依赖走 IndexedDB，理应快很多。
// 上报后按 cold 分组统计耗时，用来看「慢主要慢在冷 boot」还是热 boot 也慢。
let hasBootedOk = false

/** 一次 boot 成功的埋点：是否冷 boot + 耗时（ms）。供上层上报统计。 */
export type BootOkMeta = { cold: boolean; elapsedMs: number }
// 最近一次成功 boot 的埋点。getContainer 每次真正 boot 成功后刷新，bootAndRun 读它上报。
let lastBootOk: BootOkMeta | null = null
// 最近一次 boot 启动时是否为冷 boot（失败上报也要带上，故与成功埋点分开单独记）。
let lastBootCold = false

/** 读最近一次成功 boot 的埋点（cold + elapsedMs）。没有则 null。 */
export function getLastBootMeta(): BootOkMeta | null {
  return lastBootOk
}

/** 最近一次 boot 启动时是否为冷 boot —— 失败上报用。 */
export function wasLastBootCold(): boolean {
  return lastBootCold
}

// WebContainer.boot() 的超时兜底（ms）。boot 要从境外（StackBlitz）下载 ~470KB 运行时并握手。
// 没有超时的话，连接彻底卡死时会永远停在 booting、进度条卡 16%，用户以为死机。
//
// 关于快慢：实测同一台机器、同样开着梯子，boot 有时 1.7s 就成、有时要 1.3 分钟才下完（但仍会成）。
// 变量不在本地网络，而是 StackBlitz 那端 / 到它的链路本身在波动。所以阈值放宽到 180s，
// 只兜「彻底连不上的死连接」，不误杀「慢但能成」的下载——宁可极慢的用户多等，也别掐掉本会成功的 boot。
const BOOT_TIMEOUT_MS = 180000

// boot 失败后自动重试次数。boot 失败多是 StackBlitz 端偶发抽风，下一次往往很快就成，
// 所以失败先自动重试，别一上来就把错误甩给用户。总尝试次数 = 1 + BOOT_MAX_RETRIES。
const BOOT_MAX_RETRIES = 1

/** boot 失败时抛出的专用错误：带上「卡了多久」与「是否超时」，供上层上报后端定位。 */
export class BootError extends Error {
  // 显式字段声明（不用构造函数参数属性）——项目开了 erasableSyntaxOnly，禁止参数属性写法。
  readonly kind: 'timeout' | 'error'
  readonly elapsedMs: number

  constructor(message: string, kind: 'timeout' | 'error', elapsedMs: number) {
    super(message)
    this.name = 'BootError'
    this.kind = kind
    this.elapsedMs = elapsedMs
  }
}


// ── dist 产物缓存（内容寻址）─────────────────────────────────────
// 痛点：切版本 / 回滚是瞬时的，但预览每次都重新跑一遍 `vite build`（几秒），切完要干等。
// 而 dist 其实是「源文件」的纯函数（toolchain 固定在模板里），同一份源文件 → 同一份 dist。
// 所以按【源文件内容哈希】缓存每次成功构建的 dist：切回内容一样的版本时直接还原产物、
// 跳过 build，预览秒切。注意不能按版本号缓存 —— 回滚会生成全新的内部版本号，永远命中不了；
// 内容哈希才能让「回滚到 v3」和「当初的 v3」对上。
// 只放内存（刷新即丢），一次会话内来回切版本是主场景，够用；跨会话同模板也能蹭到。
const distCache = new Map<string, BuiltFile[]>()
const DIST_CACHE_MAX = 12  // 最多缓存几份 dist，超了按最久未用淘汰，防内存无限涨
// 缓存格式版本：并进 key 前缀。dist 读写逻辑 / bridge 注入这类「会改变产物」的东西变动时
// +1，旧持久化缓存自然失配作废（IDB 里的旧条目会被淘汰逻辑慢慢清掉）。
const DIST_CACHE_VERSION = 'v3'  // v2→v3：加入浏览器端布局验收桥，旧 dist 未注入该桥，作废重建

/** 写入 dist 缓存（近似 LRU：重新插到末尾刷新最近使用，超量淘汰最老的）。 */
function putDistCache(key: string, dist: BuiltFile[]): void {
  if (distCache.has(key)) distCache.delete(key)
  distCache.set(key, dist)
  while (distCache.size > DIST_CACHE_MAX) {
    const oldest = distCache.keys().next().value
    if (oldest === undefined) break
    distCache.delete(oldest)
  }
}

/** 对一份源文件算稳定的内容哈希，作为 dist 缓存的 key。
 *  路径排序后用 \0 分隔 path/content 拼接再 SHA-256（COOP/COEP 下 crypto.subtle 可用）。
 *  算不出（极少见）就返回 null，调用方据此退回「不缓存、照常 build」。 */
async function computeFilesKey(files: FileMap): Promise<string | null> {
  try {
    const stable = Object.keys(files)
      .sort()
      .map((p) => `${p}\0${files[p]}`)
      .join('\n')
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable))
    const hex = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    return `${DIST_CACHE_VERSION}:${hex}`
  } catch {
    return null
  }
}

/** 取一份 dist：先查内存（L1，快），没有再查 IndexedDB（L2，跨刷新），命中则回填 L1。
 *  两级都没有返回 null，调用方据此走真正的 `vite build`。 */
async function lookupDist(key: string): Promise<BuiltFile[] | null> {
  const mem = distCache.get(key)
  if (mem) return mem
  const persisted = await getDist(key)
  if (persisted) {
    putDistCache(key, persisted)  // 回填内存，下次同会话切版本走 L1
    return persisted
  }
  return null
}

/** 同时写两级缓存：内存（L1）即时可用，IndexedDB（L2）后台落盘、不阻塞构建主流程。 */
function storeDist(key: string, dist: BuiltFile[]): void {
  putDistCache(key, dist)
  void putDist(key, dist)  // best-effort 持久化，内部已 try/catch
}

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

// 去掉 ANSI 转义序列（颜色 / 光标控制 / OSC），只留可读文本，方便回传。
function stripAnsi(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
}

/** 给一次底层 boot 套超时：boot 成功/失败正常透传；到点没结果就抛 timeout BootError。
 *  注意：超时只是"我们不再等了"，底层 WebContainer.boot() 仍在跑——所以超时后【不能】再调
 *  一次 boot()（WebContainer 限定一个页面只能 boot 一次，重复调会报"单实例"错）。 */
function bootWithTimeout(): Promise<WebContainer> {
  const startedAt = Date.now()
  return new Promise<WebContainer>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new BootError(
        '运行环境启动超时：可能是网络无法稳定访问境外 CDN（StackBlitz）。请刷新重试，或切换网络。',
        'timeout',
        Date.now() - startedAt,
      ))
    }, BOOT_TIMEOUT_MS)
    WebContainer.boot().then(
      (wc) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(wc)
      },
      (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const msg = e instanceof Error ? e.message : String(e)
        reject(new BootError(msg, 'error', Date.now() - startedAt))
      },
    )
  })
}

/** 启动（首次调用真正 boot，之后返回同一个实例）。
 *  boot 失败多是 StackBlitz 端偶发抽风、下一次往往很快就成，所以对【报错型】失败自动重试。
 *  超时型失败不重试（底层 boot 还挂着，重复调 boot() 会触发"单实例"错）——直接抛给上层报错+上报。
 *  任一情况最终失败都清空单例，允许用户刷新后重来。 */
export function getContainer(): Promise<WebContainer> {
  if (!containerPromise) {
    // 本次 boot 是不是冷 boot：会话里还没成功 boot 过 = 冷。成功/失败上报都要用。
    const cold = !hasBootedOk
    lastBootCold = cold
    containerPromise = (async () => {
      let lastErr: unknown
      for (let attempt = 0; attempt <= BOOT_MAX_RETRIES; attempt++) {
        try {
          const startedAt = Date.now()
          const wc = await bootWithTimeout()
          // 成功：记冷/热耗时埋点，标记「本会话已成功 boot 过」（后续都算热 boot）。
          hasBootedOk = true
          lastBootOk = { cold, elapsedMs: Date.now() - startedAt }
          return wc
        } catch (e) {
          lastErr = e
          // 超时：底层 boot 仍在进行，不能再 boot()，直接放弃、抛给上层。
          if (e instanceof BootError && e.kind === 'timeout') break
          // 报错：底层 boot 已 settle（失败），可以安全地再试一次新 boot。
          if (attempt < BOOT_MAX_RETRIES) {
            broadcast('\x1b[33m\r\n[diag] 运行环境启动失败，正在自动重试…\x1b[0m\r\n')
          }
        }
      }
      throw lastErr
    })()
    // boot 失败要把单例清空，否则这个 rejected promise 会被永久缓存，
    // 用户刷新（不重建模块）后再 boot 也拿到同一个失败结果、再也起不来。
    containerPromise.catch(() => {
      containerPromise = null
    })
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
        type: 'xiaozhu-console',
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
// - 反向：监听父页面发来的 xiaozhu-nav-cmd 指令，在 iframe 内执行
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
    try { window.parent.postMessage({ type: 'xiaozhu-nav', kind: kind, path: cur() }, '*'); } catch(e) {}
  }
  var _push = history.pushState;
  history.pushState = function(){ var r = _push.apply(this, arguments); report('push'); return r; };
  var _replace = history.replaceState;
  history.replaceState = function(){ var r = _replace.apply(this, arguments); report('replace'); return r; };
  window.addEventListener('popstate', function(){ report('pop'); });
  window.addEventListener('hashchange', function(){ report('pop'); });
  window.addEventListener('message', function(e){
    var d = e.data;
    if (!d || d.type !== 'xiaozhu-nav-cmd') return;
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

// ── 基础布局验收桥接脚本 ──────────────────────────────────────
// agent 看不到真实画面，因此在 iframe 内用浏览器实际布局数据做一层确定性检查：
// 横向溢出、桌面仍被锁成手机窄画布、fixed 元素逃出应用壳都直接回报父页面。
// 明确的手机模拟器可以在根壳加 data-preview-mode="mobile" 跳过「桌面窄壳」规则，
// 但横向溢出和 fixed 越界仍然必须修复。
const LAYOUT_BRIDGE_SCRIPT = `<script>(function(){
  if (window.__xiaozhuLayoutBridged) return;
  window.__xiaozhuLayoutBridged = true;
  var timer = 0;
  function add(issues, message) {
    if (issues.indexOf(message) === -1) issues.push(message);
  }
  function inspect() {
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!vw || !vh) return;
    var issues = [];
    var doc = document.documentElement;
    var body = document.body;
    var pageWidth = Math.max(doc.scrollWidth, body ? body.scrollWidth : 0);
    if (pageWidth > vw + 8) {
      add(issues, '[布局验收] 页面横向溢出 ' + Math.round(pageWidth - vw) + 'px；请移除超宽固定尺寸，并让内容在当前宽度内换行或收缩。');
    }

    var root = document.getElementById('root');
    var shell = root && root.firstElementChild;
    var shellRect = shell && shell.getBoundingClientRect();
    var mobileMode = shell && shell.getAttribute('data-preview-mode') === 'mobile';
    if (!mobileMode && vw >= 960 && shellRect &&
        shellRect.height >= vh * 0.75 && shellRect.width < vw * 0.65) {
      add(issues, '[布局验收] 桌面预览宽 ' + vw + 'px，但根应用仅占 ' + Math.round(shellRect.width) + 'px，呈现为手机窄画布；请让根应用铺满视口并用响应式断点重排。');
    }

    if (shellRect && shellRect.width < vw * 0.82) {
      var nodes = document.querySelectorAll('body *');
      for (var i = 0; i < nodes.length && i < 5000; i++) {
        var node = nodes[i];
        var style = window.getComputedStyle(node);
        if (style.position !== 'fixed') continue;
        var rect = node.getBoundingClientRect();
        if (rect.width > shellRect.width + 16) {
          add(issues, '[布局验收] fixed 元素宽 ' + Math.round(rect.width) + 'px，已逃出 ' + Math.round(shellRect.width) + 'px 的应用内容壳；请让固定底栏/浮层与内容壳同宽并居中。');
          break;
        }
      }
    }

    var fixedNodes = document.querySelectorAll('body *');
    for (var j = 0; j < fixedNodes.length && j < 5000; j++) {
      var fixedNode = fixedNodes[j];
      if (window.getComputedStyle(fixedNode).position !== 'fixed') continue;
      var fixedRect = fixedNode.getBoundingClientRect();
      if (fixedRect.left < -4 || fixedRect.right > vw + 4) {
        add(issues, '[布局验收] fixed 元素越出可视区域；请检查 left/right/width 与响应式约束。');
        break;
      }
    }

    try {
      window.parent.postMessage({
        type: 'xiaozhu-layout',
        issues: issues.slice(0, 6),
        viewport: { width: vw, height: vh }
      }, '*');
    } catch(e) {}
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(inspect, 220);
  }
  window.addEventListener('load', schedule);
  window.addEventListener('resize', schedule);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule);
  } else {
    schedule();
  }
  setTimeout(inspect, 900);
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

/** 把 console、路由导航、布局验收桥都注入到 index.html（幂等）。
 *  三处脚本互相独立，分别用各自的旗标判断是否已注入。 */
function injectConsoleBridge(files: FileMap): FileMap {
  let next = injectScript(files, CONSOLE_BRIDGE_SCRIPT, '__vibuildConsoleBridged')
  next = injectScript(next, NAV_BRIDGE_SCRIPT, '__vibuildNavBridged')
  next = injectScript(next, LAYOUT_BRIDGE_SCRIPT, '__xiaozhuLayoutBridged')
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
 *  banner 让用户知道"现在是在 install 阶段还是 build 阶段"。 */
function pipeRawToBus(output: ReadableStream<string>, banner: string) {
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

// ── build 预览：在容器里 vite build 出 dist ─────────────────────
// 预览的核心。直接 `npx vite build`（不走 `npm run build`，那是 `tsc && vite build`，
// AI 代码常有类型报错会被 tsc 卡住，而预览只要能跑的产物）。base 用默认 '/'，因为预览是
// 挂在 vite preview 根路径下的 iframe（分享才需要 --base=./ 挂子路径，那条路径见 buildDist）。
//
// 编译过没过就是这里的【退出码】。失败时把构建输出的尾部喂给 server-error 通道
// （PreviewPane 会转发到控制台面板 + 后端 log_store），agent 的 check_build 立刻能
// 看到「构建都没过」——一次构建对应一条权威信号，确定、好抓。

/** 从构建原始输出里抽出可回传的错误摘要：去掉 ANSI、归一化容器绝对路径、取尾部一段。 */
function buildErrorTail(rawOutput: string): string {
  const norm = stripAnsi(rawOutput).replace(/\/home\/[^/\s]+\//g, '')
  // 错误通常打印在最后，取尾部 1800 字符够 agent 定位；首尾留白裁掉。
  return norm.slice(-1800).trim()
}

/** 一次构建的结果：ok=退出码为 0；失败时 error 带错误摘要（供回传后端 + 显示控制台）。 */
export type BuildOutcome = { ok: boolean; error: string | null }

/**
 * 跑一次 `vite build`。一次性进程，靠退出码判断成败（不像 dev server 要扫输出流找报错）。
 * 成败 + 错误摘要都通过返回值交给调用方处理（不再走发布订阅），由它决定回传 / 显示。
 */
async function runBuild(wc: WebContainer, hooks?: { onLog?: (line: string) => void }): Promise<BuildOutcome> {
  hooks?.onLog?.('vite build')
  const build = await wc.spawn('npx', ['vite', 'build'])
  // 输出一边照常进终端（给人看），一边攒进 buf —— 构建失败时要把它当错误回传。
  broadcast('\x1b[36m\r\n— vite build —\x1b[0m\r\n')
  let buf = ''
  const piped = build.output.pipeTo(
    new WritableStream({
      write(chunk) {
        const s = chunk.toString()
        broadcast(s)
        buf += s
      },
    }),
  )
  const code = await build.exit
  // 等输出流 drain 完，确保失败时错误尾部完整落进 buf 再判断（别漏掉最后一截报错）。
  await piped.catch(() => {})
  if (code !== 0) {
    return { ok: false, error: `[vite build] 构建失败 (exit ${code})：${buildErrorTail(buf)}` }
  }
  return { ok: true, error: null }
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
    onStatus: (s: 'booting' | 'mounting' | 'installing' | 'building' | 'starting' | 'ready' | 'error') => void
    onUrl: (url: string) => void
    onLog: (line: string) => void
    onError: (msg: string) => void
    // boot / 启动流程失败时回调，带上诊断信息供上层上报后端监控（best-effort）。
    // stage：卡在哪一步；kind：超时还是异常；elapsedMs：boot 阶段耗时（仅 boot 失败时有）。
    onBootFail?: (info: {
      stage: string
      kind: 'timeout' | 'error'
      message: string
      elapsedMs?: number
      cold?: boolean
    }) => void
    // boot 成功回调：带冷/热标记 + 耗时，供上层上报统计 boot 耗时分布。
    // 只在这次 bootAndRun 真的触发了一次 boot（而非复用已 ready 的实例）时才回调。
    onBootOk?: (info: { cold: boolean; elapsedMs: number }) => void
  },
): Promise<void> {
  // 记录当前阶段：失败上报时要知道卡在 booting 还是后续哪一步。
  let stage = 'booting'
  // 进来时是否已有容器：若已 boot 过（复用实例），这次并不会真的触发 boot，
  // 不能把上一次的成功埋点误报成本次。只有「这次真的新 boot 了」才上报 onBootOk。
  const willBoot = !isBooted()
  try {
    hooks.onStatus('booting')
    const wc = await getContainer()
    // 仅当这次确实新 boot 了才上报成功耗时（避免复用实例时误报旧埋点）。
    if (willBoot) {
      const okMeta = getLastBootMeta()
      if (okMeta) hooks.onBootOk?.(okMeta)
    }

    stage = 'mounting'
    hooks.onStatus('mounting')
    // 把 console bridge 脚本注入到 index.html，让 iframe 里的业务代码 console
    // 都能被父页面收到
    const filesWithBridge = injectConsoleBridge(files)
    await wc.mount(toFileTree(filesWithBridge))
    lastFiles = { ...filesWithBridge }

    // 监听 server-ready 事件（vite preview 端口 ready 时触发）：iframe 加载预览 URL
    wc.on('server-ready', (_port, url) => {
      hooks.onUrl(url)
      hooks.onStatus('ready')
      hooks.onLog('preview ready')
    })

    // 依赖安装：先尝试从 IndexedDB 缓存恢复 node_modules，命中则跳过 npm install
    stage = 'installing'
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

    // ── 先 vite build 出 dist，再 vite preview 起静态服务 ──
    // 首次构建（构建的是后端预置的完整模板）必须成功才有 dist 可供预览；失败直接抛错，
    // 进 catch 显示错误态（错误详情已通过 server-error 通道回传后端/控制台）。
    // ── 首屏产出 dist ──
    // 先查缓存（含 IndexedDB L2）：刷新 / 重开浏览器后若这份内容之前构建过，直接还原 dist、
    // 跳过这次 `vite build`（首屏最耗时的一步），boot 明显更快。命中不了才真正构建。
    hooks.onStatus('building')
    stage = 'building'
    const bootKey = await computeFilesKey(filesWithBridge)
    let restoredDist = false
    if (bootKey) {
      const cached = await lookupDist(bootKey)
      if (cached) {
        hooks.onLog('命中 dist 缓存，跳过首次构建')
        broadcast('\x1b[36m\r\n— 命中 dist 缓存，跳过首次构建 —\x1b[0m\r\n')
        await restoreDist(wc, cached)
        restoredDist = true
      }
    }
    if (!restoredDist) {
      const first = await runBuild(wc, { onLog: hooks.onLog })
      if (!first.ok) {
        throw new Error(first.error ?? '首次构建失败，请查看控制台的构建报错后让 AI 修复')
      }
      // 缓存首屏 dist（两级）：之后切回这份内容、或刷新重开，都能直接还原、不再 build。
      if (bootKey) {
        try {
          storeDist(bootKey, await readDistFiles(wc))
        } catch (e) {
          console.warn('首屏 dist 缓存写入失败（不影响运行）', e)
        }
      }
    }
    // vite preview 是常驻静态服务，serve dist。它开端口后会触发上面注册的
    // 统一 server-ready 处理器（onUrl + ready），iframe 照常加载，无需额外接线。
    hooks.onStatus('starting')
    stage = 'starting'
    hooks.onLog('vite preview')
    const preview = await wc.spawn('npx', ['vite', 'preview', '--port', '4173'])
    previewStarted = true
    pipeRawToBus(preview.output, 'vite preview')
    // 不 await preview.exit —— 它是常驻进程
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    hooks.onError(msg)
    hooks.onStatus('error')
    // 上报失败供后台监控。BootError 带 kind/elapsedMs（boot 阶段专有）；其余阶段的异常
    // 归为 kind='error'。stage 标明卡在哪一步，绝大多数境外依赖问题会是 stage='booting'。
    const isBootErr = e instanceof BootError
    hooks.onBootFail?.({
      stage,
      kind: isBootErr ? e.kind : 'error',
      message: msg,
      elapsedMs: isBootErr ? e.elapsedMs : undefined,
      cold: wasLastBootCold(),
    })
  }
}

/** 把一份源文件增量同步进容器（纯 fs 写，不构建），并更新 lastFiles。
 *  和构建解耦：无论后面走「还原缓存 dist」还是「重新 build」，源文件与 lastFiles 都先对齐，
 *  保证下一次 diff 始终准确。返回各类变更数。 */
async function writeSourceDiff(
  wc: WebContainer,
  filesWithBridge: FileMap,
  hooks: { onLog: (line: string) => void },
): Promise<{ added: number; modified: number; removed: number }> {
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

/** 计算 diff，将变化文件增量写入容器，再产出新 dist 供预览。
 *  产出 dist 有两条路：
 *    1. 命中内容缓存（切回构建过的版本）→ 直接还原那次的 dist，跳过几秒 build，预览秒切；
 *    2. 未命中 → 正常 `vite build`，成功后把 dist 读出来缓存，供下次秒切。
 *  返回 buildOk（供 PreviewPane 决定是否刷新 iframe）、buildError（失败摘要，回传后端 +
 *  显示控制台）、fromCache（是否走了缓存，便于上层日志/调试）。 */
export async function syncFiles(
  files: FileMap,
  hooks: { onLog: (line: string) => void },
): Promise<{ added: number; modified: number; removed: number; buildOk: boolean; buildError: string | null; fromCache: boolean }> {
  const wc = await getContainer()
  // 同步阶段也确保 index.html 始终带 bridge —— 否则 LLM 改 html 会把它覆盖掉
  const filesWithBridge = injectConsoleBridge(files)

  // 先把源文件对齐进容器（快），保证缓存命中与否，lastFiles 都准。
  const { added, modified, removed } = await writeSourceDiff(wc, filesWithBridge, hooks)

  // 文件一点没变 → 本就无需重建（视作「构建通过」），PreviewPane 仍会据此回报 build-result，
  // 免得后端 check_build 干等到超时。
  if (added + modified + removed === 0) {
    return { added, modified, removed, buildOk: true, buildError: null, fromCache: false }
  }

  // ── 内容缓存命中：同一份源文件之前已成功构建过 → 直接还原 dist，免去几秒 build ──
  // 两级查找：内存 L1 → IndexedDB L2（跨刷新）。回滚 / 来回切版本最常命中这里。
  const key = await computeFilesKey(filesWithBridge)
  if (key) {
    const cached = await lookupDist(key)
    if (cached) {
      hooks.onLog('命中 dist 缓存，跳过构建')
      broadcast('\x1b[36m\r\n— 命中 dist 缓存，跳过构建 —\x1b[0m\r\n')
      await restoreDist(wc, cached)
      putDistCache(key, cached)  // 刷新 LRU 最近使用
      return { added, modified, removed, buildOk: true, buildError: null, fromCache: true }
    }
  }

  // ── 未命中：正常构建，成功后写两级缓存（内存即时 + IndexedDB 落盘）供下次秒切 ──
  const { ok, error } = await runBuild(wc, { onLog: hooks.onLog })
  if (ok && key) {
    try {
      storeDist(key, await readDistFiles(wc))
    } catch (e) {
      console.warn('dist 缓存写入失败（不影响本次预览）', e)
    }
  }
  return { added, modified, removed, buildOk: ok, buildError: error, fromCache: false }
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

/** base64 还原成字节数组（restoreDist 写回二进制产物用，bytesToBase64 的逆）。 */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** 把容器里当前的 dist 目录读成一组文件（文本存原文、二进制 base64）。
 *  供 dist 缓存（按内容缓存产物）和分享构建（buildDist）共用。 */
async function readDistFiles(wc: WebContainer): Promise<BuiltFile[]> {
  const paths = await listFilesRecursive(wc, 'dist')
  const files: BuiltFile[] = []
  for (const full of paths) {
    const rel = full.replace(/^dist\//, '')  // 去掉 dist/ 前缀，存相对路径
    if (isTextPath(rel)) {
      files.push({ path: rel, content: await wc.fs.readFile(full, 'utf-8'), isBase64: false })
    } else {
      files.push({ path: rel, content: bytesToBase64(await wc.fs.readFile(full)), isBase64: true })
    }
  }
  return files
}

/** 用缓存的一组 dist 文件覆盖容器里的 dist 目录。
 *  先整体删掉旧 dist 再写回 —— 产物文件名带内容哈希，不清旧 chunk 会残留。
 *  vite preview 是从磁盘按请求 serve 的静态服务，写完后 reload iframe 就会拿到新产物。 */
async function restoreDist(wc: WebContainer, files: BuiltFile[]): Promise<void> {
  await wc.fs.rm('dist', { recursive: true, force: true }).catch(() => {})
  for (const f of files) {
    const full = `dist/${f.path}`
    const dir = full.split('/').slice(0, -1).join('/')
    if (dir) {
      try {
        await wc.fs.mkdir(dir, { recursive: true })
      } catch {
        // 已存在则忽略
      }
    }
    if (f.isBase64) {
      await wc.fs.writeFile(full, base64ToBytes(f.content))
    } else {
      await wc.fs.writeFile(full, f.content)
    }
  }
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

  const files = await readDistFiles(wc)
  if (files.length === 0) {
    throw new Error('构建产物为空（dist 没有文件）')
  }
  hooks?.onLog?.(`dist 读取完成，共 ${files.length} 个文件`)
  return files
}

/** 当前是否已 boot（用于决定走全量还是增量） */
export function isBooted(): boolean {
  return containerPromise !== null
}

/** 预览静态服务（vite preview）是否已起来（用于决定能否增量 syncFiles / 分享构建） */
export function isPreviewRunning(): boolean {
  return previewStarted
}

/**
 * 销毁当前容器并清空所有单例状态，为下一个项目腾位。
 * 切 / 开会话时调用 —— WebContainer 明确「同一时刻只能有一个实例」，
 * 必须先 teardown 才能重新 boot，否则上个项目的 FS / preview 服务 / 终端日志
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
  previewStarted = false
  lastFiles = null
  // 清空日志回放缓冲，并给已挂载的 xterm 发「清屏 + 清回滚」指令，
  // 否则上个项目的 npm / build 日志会一直留在终端里。
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
