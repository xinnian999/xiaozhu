import { create } from 'zustand'

// ============================================
// Theme store：深 / 浅主题切换（与主前端 web/src/store/theme.ts 风格一致）
// ============================================

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'xiaozhu-admin:theme'

const getInitial = (): Theme => {
  if (typeof window === 'undefined') return 'light'
  const saved = window.localStorage.getItem(STORAGE_KEY) as Theme | null
  if (saved === 'dark' || saved === 'light') return saved
  return 'light'
}

type ThemeState = {
  theme: Theme
  setTheme: (t: Theme) => void
  toggle: () => void
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: getInitial(),
  setTheme: (theme) => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem(STORAGE_KEY, theme)
    set({ theme })
  },
  toggle: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark'
    get().setTheme(next)
  },
}))
