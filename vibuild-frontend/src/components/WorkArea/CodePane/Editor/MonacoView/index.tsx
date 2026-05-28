import { Editor as MonacoEditor, type OnMount } from '@monaco-editor/react'
import { useSessionStore } from '@/store/session'
import { useThemeStore } from '@/store/theme'
import { detectLanguage } from '@/lib/tree'
import styles from './index.module.scss'

// ============================================
// Monaco 视图：只读，跟随主题切换
// ============================================
type Props = { path: string }

export default function MonacoView({ path }: Props) {
  const currentVersion = useSessionStore((s) => s.currentVersion())
  const theme = useThemeStore((s) => s.theme)

  const value = currentVersion.files[path] ?? ''
  const language = detectLanguage(path)

  // 自定义 Monaco 主题：跟我们的设计系统对齐
  const handleMount: OnMount = (_editor, monaco) => {
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
        options={{
          readOnly: true,
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
