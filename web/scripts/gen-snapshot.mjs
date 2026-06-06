// ── 脚本化生成预置依赖快照 deps-snapshot.{bin,json} ──────────────────
//
// 思路：起一个 vite dev server（沿用 vite.config.ts 里的 COOP/COEP 头）→
//       Playwright 开无头 Chromium → 打开 /snapshot.html，里面跑真实 WebContainer
//       装依赖并导出快照 → 拦截浏览器下载，写进 web/public/。
//
// 为什么非浏览器不可：WebContainer 只能在浏览器跑（依赖 SharedArrayBuffer）；
// node_modules 平台二进制必须由 WebContainer 自己的 npm 装，本地 Node install 出来
// 的是宿主平台二进制，挂不上。详见 src/snapshot-harness.ts 顶部注释。
//
// 用法：
//   1) 一次性安装浏览器内核：  bunx playwright install chromium
//   2) 改了模板依赖后重新生成：  bun run gen-snapshot
//      （生成的两个文件会覆盖 web/public/deps-snapshot.{bin,json}，记得提交）

import { createServer } from 'vite'
import { chromium } from 'playwright'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(__dirname, '..') // web/
const repoRoot = path.resolve(webRoot, '..') // 仓库根
// 单一数据源：模板 package.json（depsKey 与运行时一致全靠它）
const templatePkgPath = path.join(repoRoot, 'server/templates/vite-react/package.json')
const publicDir = path.join(webRoot, 'public')

const TIMEOUT = 5 * 60 * 1000 // npm install + 导出，给足 5 分钟

async function main() {
  const templatePkg = await readFile(templatePkgPath, 'utf-8')
  console.log('读取模板:', path.relative(repoRoot, templatePkgPath))

  // 1) 起 vite dev：root 指到 web/，沿用 vite.config.ts 的 COOP/COEP；关掉自动开浏览器
  const server = await createServer({
    root: webRoot,
    server: { open: false },
  })
  await server.listen()
  const base = server.resolvedUrls?.local?.[0]
  if (!base) throw new Error('vite dev server 没拿到本地 URL')
  console.log('vite dev:', base)

  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ acceptDownloads: true })
    const page = await context.newPage()

    // 注入模板 package.json，供 harness 读取
    await page.addInitScript((pkg) => {
      window.__templatePkg = pkg
    }, templatePkg)

    // 把页面 console 透传出来，方便看 npm install 进度
    page.on('console', (m) => console.log('  ', m.text()))

    // 拦截 harness 触发的两个下载，落盘到 public/
    const saved = []
    page.on('download', (d) => {
      const name = d.suggestedFilename()
      saved.push(d.saveAs(path.join(publicDir, name)).then(() => name))
    })

    await page.goto(new URL('scripts/snapshot.html', base).href)

    // 等 harness 完成或报错
    await page.waitForFunction(
      () => window.__snapshotDone === true || !!window.__snapshotError,
      null,
      { timeout: TIMEOUT },
    )
    const err = await page.evaluate(() => window.__snapshotError)
    if (err) throw new Error('harness 出错: ' + err)

    // 下载事件可能略晚于完成标志，等两个文件都落盘（最多再等 30s）
    const deadline = Date.now() + 30_000
    while (saved.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    const names = await Promise.all(saved)
    if (!names.includes('deps-snapshot.bin') || !names.includes('deps-snapshot.json')) {
      throw new Error('下载文件不齐: ' + names.join(', '))
    }
    console.log('已写入:', names.map((n) => path.join('public', n)).join(', '))
  } finally {
    await browser.close()
    await server.close()
  }
}

main().then(
  () => {
    console.log('✅ 快照生成完成')
    process.exit(0)
  },
  (e) => {
    console.error('❌', e)
    process.exit(1)
  },
)
