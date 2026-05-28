import { create } from 'zustand'

// ============================================
// Editor store：管理代码视图中打开的 Tab
// ============================================

type EditorState = {
  /** 当前已打开的文件路径列表（按打开顺序） */
  openPaths: string[]
  /** 当前激活的 tab 路径 */
  activePath: string | null
  /** 打开文件（已打开则切换激活） */
  openFile: (path: string) => void
  /** 关闭文件 */
  closeFile: (path: string) => void
  /** 清空（切换版本时调用） */
  reset: (initialPath?: string) => void
}

export const useEditorStore = create<EditorState>((set) => ({
  openPaths: [],
  activePath: null,
  openFile: (path) =>
    set((s) => {
      if (s.openPaths.includes(path)) {
        return { ...s, activePath: path }
      }
      return { openPaths: [...s.openPaths, path], activePath: path }
    }),
  closeFile: (path) =>
    set((s) => {
      const idx = s.openPaths.indexOf(path)
      if (idx === -1) return s
      const next = s.openPaths.filter((p) => p !== path)
      let activePath = s.activePath
      if (activePath === path) {
        // 关掉当前激活：优先取右侧，否则左侧，否则 null
        activePath = next[idx] ?? next[idx - 1] ?? null
      }
      return { openPaths: next, activePath }
    }),
  reset: (initialPath) =>
    set(() => ({
      openPaths: initialPath ? [initialPath] : [],
      activePath: initialPath ?? null,
    })),
}))
