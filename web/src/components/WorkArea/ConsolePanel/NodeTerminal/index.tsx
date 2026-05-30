import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { subscribeProcessOutput } from '@/lib/webcontainer'
import styles from './index.module.scss'

// ============================================
// Node 进程终端：用 xterm.js 直接渲染 WebContainer 的原始输出
// ============================================
// 不再自己解析 ANSI / 拆行。xterm 是 VSCode 同款终端模拟器，
// 颜色 / 光标 / 进度条它全自动处理。
//
// 工作流程：
// 1. 挂载时 new Terminal()，绑到 container div
// 2. subscribeProcessOutput(chunk => term.write(chunk))，
//    订阅时会立即回放 history，所以不会"漏前面的日志"
// 3. ResizeObserver 让面板高度变化时调用 fit() 重排
// 4. 卸载时 dispose
export default function NodeTerminal() {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    // 创建 xterm 实例
    // convertEol: true —— 自动把 \n 当成 \r\n，省去后端规整
    // disableStdin: true —— 我们只展示，不接受用户输入
    const term = new Terminal({
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.3,
      scrollback: 2000,
      theme: getTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    // 订阅原始字节流。subscribe 立即回放 history，所以即便 install/dev 已经跑完，
    // 终端打开后也能看到全部历史输出。
    const unsubscribe = subscribeProcessOutput((chunk) => {
      term.write(chunk)
    })

    // 面板高度变化时让终端自适应
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // 容器尺寸为 0 时 fit 会抛，忽略
      }
    })
    ro.observe(el)

    return () => {
      unsubscribe()
      ro.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  return <div ref={containerRef} className={styles.terminal} />
}

// 简单的暗色调主题，跟项目 accent 协调
// 这里写死颜色而不是用 var(--color-*)，因为 xterm 需要 hex/rgb 字符串，
// 解析 CSS 变量太麻烦；后续真要支持浅色再 conditionally 切换
function getTheme() {
  return {
    background: '#00000000', // 透明，让父容器底色透出
    foreground: '#d4d4d4',
    cursor: '#d4d4d4',
    black: '#000000',
    red: '#e07070',
    green: '#7ec07e',
    yellow: '#d9a25b',
    blue: '#6aa1d8',
    magenta: '#c878c8',
    cyan: '#6acfcf',
    white: '#d4d4d4',
    brightBlack: '#666666',
    brightRed: '#ff8888',
    brightGreen: '#a4d98a',
    brightYellow: '#ffcc66',
    brightBlue: '#88b8ee',
    brightMagenta: '#e0a0e0',
    brightCyan: '#88dddd',
    brightWhite: '#ffffff',
  }
}
