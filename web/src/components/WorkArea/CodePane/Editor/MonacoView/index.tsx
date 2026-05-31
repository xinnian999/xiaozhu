import { Editor as MonacoEditor, type OnMount } from '@monaco-editor/react'
import { useSessionStore } from '@/store/session'
import { useThemeStore } from '@/store/theme'
import { detectLanguage } from '@/lib/tree'
import styles from './index.module.scss'

// ============================================
// Monaco 视图：可编辑，跟随主题切换
// - 编辑只写进前端草稿（不动 files / 不触发预览同步）
// - 等用户点顶栏「保存」才落库并产生新版本
// - AI 流式生成期间转只读，避免和 AI 的写入打架
// ============================================
type Props = { path: string }

export default function MonacoView({ path }: Props) {
  const session = useSessionStore((s) => s.activeSession())
  const setDraft = useSessionStore((s) => s.setDraft)
  const theme = useThemeStore((s) => s.theme)

  const isStreaming = session?.isStreaming ?? false
  // 显示内容：有未保存草稿就显示草稿，否则显示已保存版本
  const committed = session?.files[path] ?? ''
  const draft = session?.drafts[path]
  const value = draft !== undefined ? draft : committed
  const language = detectLanguage(path)

  // 编辑内容只写进草稿即可，预览要等用户点「保存」后才更新
  const handleChange = (val: string | undefined) => {
    if (val === undefined) return
    setDraft(path, val)
  }

  // 自定义 Monaco 主题：跟我们的设计系统对齐
  const handleMount: OnMount = (_editor, monaco) => {
    // Monaco 自带的 TS 语言服务默认不开 JSX、也读不到项目的 tsconfig / node_modules，
    // 于是 .tsx 会满屏报「Cannot use JSX」「找不到 react 模块」。这里全局配置一次：
    // 1) 开启 JSX 解析，消除 17004；2) 关掉语义校验，避免「找不到模块 / 隐式 any」误报
    //    —— 真正的类型/编译检查交给 WebContainer 里的 Vite，这里只当编辑器用。
    const ts = monaco.languages.typescript
    ts.typescriptDefaults.setCompilerOptions({
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      allowJs: true,
      allowNonTsExtensions: true,
      noEmit: true,
    })
    ts.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true, // 关语义校验：没装 @types/react，否则满屏「找不到模块」
      noSyntaxValidation: false, // 保留语法校验：真正的括号 / 拼写错误仍然提示
    })

    monaco.editor.defineTheme('vibuild-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '5a5660', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'ff7faa' },
        { token: 'string', foreground: 'ffd089' },
        { token: 'number', foreground: 'a8c7fa' },
        { token: 'type', foreground: '8be9fd' },
        { token: 'function', foreground: 'c8a8ff' },
      ],
      colors: {
        'editor.background': '#08080a',
        'editor.foreground': '#f3f1ed',
        'editorLineNumber.foreground': '#3f3c44',
        'editorLineNumber.activeForeground': '#a8a4ad',
        'editor.selectionBackground': '#ff3d6e33',
        'editor.lineHighlightBackground': '#16151a',
        'editor.lineHighlightBorder': '#00000000',
        'editorCursor.foreground': '#ff3d6e',
        'editorIndentGuide.background1': '#1a191e',
        'editorIndentGuide.activeBackground1': '#2a282f',
        'editor.findMatchBackground': '#ff3d6e44',
        'editorBracketMatch.background': '#ff3d6e22',
        'editorBracketMatch.border': '#ff3d6e88',
        'scrollbarSlider.background': '#1f1d24',
        'scrollbarSlider.hoverBackground': '#2a282f',
        'scrollbarSlider.activeBackground': '#3a373f',
      },
    })
    monaco.editor.defineTheme('vibuild-light', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '988f7a', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'be1640' },
        { token: 'string', foreground: '7c3aed' },
        { token: 'number', foreground: '0284c7' },
      ],
      colors: {
        'editor.background': '#fbfaf6',
        'editor.foreground': '#15131a',
        'editorLineNumber.foreground': '#c0bcc4',
        'editorLineNumber.activeForeground': '#5c5860',
        'editor.selectionBackground': '#e11d4822',
        'editor.lineHighlightBackground': '#f0ece2',
        'editorCursor.foreground': '#e11d48',
      },
    })
  }

  return (
    <div className={styles.monaco}>
      <MonacoEditor
        path={path}
        value={value}
        language={language}
        theme={theme === 'dark' ? 'vibuild-dark' : 'vibuild-light'}
        onMount={handleMount}
        onChange={handleChange}
        options={{
          // 生成进行中只读，其余时间可编辑
          readOnly: isStreaming,
          minimap: { enabled: true, scale: 0.6, side: 'right', renderCharacters: false },
          fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace",
          fontSize: 13,
          lineHeight: 1.7,
          fontLigatures: true,
          padding: { top: 16, bottom: 16 },
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          scrollBeyondLastLine: false,
          renderLineHighlight: 'all',
          renderWhitespace: 'none',
          wordWrap: 'on',
          guides: {
            indentation: true,
            highlightActiveIndentation: true,
            bracketPairs: true,
          },
          bracketPairColorization: { enabled: true },
          contextmenu: false,
          scrollbar: {
            verticalScrollbarSize: 10,
            horizontalScrollbarSize: 10,
            useShadows: false,
          },
          overviewRulerBorder: false,
          hideCursorInOverviewRuler: true,
          // 只读模式下隐藏一些没用的 UI
          glyphMargin: false,
          folding: true,
          lineDecorationsWidth: 8,
          lineNumbersMinChars: 3,
        }}
      />
    </div>
  )
}
