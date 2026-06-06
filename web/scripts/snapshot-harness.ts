// ── 开发工具：预置依赖快照生成器（在真实浏览器里跑） ──────────────────
// 由 scripts/gen-snapshot.mjs 用 Playwright 驱动，不进任何正式 UI。
// 流程：拿脚本注入的模板 package.json → boot 真实 WebContainer → npm install
//       → wc.export('node_modules') 导出二进制快照 → 触发下载（脚本侧拦截落盘）。
//
// 为什么必须用真实 WebContainer 而不是本地 Node 直接打包：
//   node_modules 里含平台相关二进制（esbuild/rollup/vite 等），必须由 WebContainer
//   自己的 npm 在它自己的平台上装出来，才与运行时挂载环境一致。本地 mac 装出来的
//   是 darwin 二进制，挂进 WebContainer 跑不起来。

import { WebContainer } from '@webcontainer/api'
// 复用运行时同一套 depsKey 算法，避免口径漂移（manifest 与运行时校验必须一致）。
// 本文件在 src/ 之外，用相对路径直接引应用代码，不走 @ 别名。
import { computeDepsKey } from '../src/lib/depsCache'

declare global {
  interface Window {
    // 由 Playwright addInitScript 注入：模板 package.json 的原文
    __templatePkg?: string
    // harness 完成标志，脚本据此判断收尾
    __snapshotDone?: boolean
    // harness 出错信息，脚本据此 fail fast
    __snapshotError?: string
  }
}

const statusEl = document.getElementById('status')!
function setStatus(text: string): void {
  statusEl.textContent = text
  console.log('[harness]', text)
}

// 触发浏览器下载（脚本侧用 page.on('download') 拦截后落盘到 public/）
function download(data: BlobPart, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

async function main(): Promise<void> {
  const pkg = window.__templatePkg
  if (!pkg) throw new Error('缺少 window.__templatePkg（应由脚本注入模板 package.json）')

  setStatus('boot WebContainer…')
  const wc = await WebContainer.boot()

  // 装依赖只需要 package.json，不必 mount 模板源码
  setStatus('mount package.json…')
  await wc.mount({ 'package.json': { file: { contents: pkg } } })

  setStatus('npm install…（约 30s–1min）')
  const install = await wc.spawn('npm', ['install'])
  // 把安装输出转发到 console，脚本侧能看到进度
  void install.output.pipeTo(
    new WritableStream({ write: (chunk) => console.log('[npm]', chunk) }),
  )
  const code = await install.exit
  if (code !== 0) throw new Error(`npm install 失败 (exit ${code})`)

  setStatus('导出 node_modules 快照…（66MB 左右，稍候）')
  const depsKey = await computeDepsKey(pkg)
  if (!depsKey) throw new Error('computeDepsKey 返回 null（package.json 解析失败？）')
  const snapshot = await wc.export('node_modules', { format: 'binary' })

  // slice 出普通 ArrayBuffer 副本：COEP 环境下其 buffer 可能被推断为 SharedArrayBuffer，Blob 不收
  download(snapshot.slice().buffer as ArrayBuffer, 'deps-snapshot.bin', 'application/octet-stream')
  download(JSON.stringify({ depsKey }, null, 2), 'deps-snapshot.json', 'application/json')

  setStatus(`完成 depsKey=${depsKey}`)
  window.__snapshotDone = true
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e)
  window.__snapshotError = msg
  setStatus('出错: ' + msg)
  console.error(e)
})
