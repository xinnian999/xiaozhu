import { create } from 'zustand'
import { demoSession, type Session, type Version } from '@/mock/demoProjects'

// ============================================
// Session store：会话与版本切换
// ============================================

type SessionState = {
  session: Session
  /** 切换到某个版本 */
  setCurrentVersion: (versionId: string) => void
  /** 取当前版本对象 */
  currentVersion: () => Version
}

export const useSessionStore = create<SessionState>((set, get) => ({
  session: demoSession,
  setCurrentVersion: (versionId) =>
    set((s) => ({
      session: { ...s.session, currentVersionId: versionId },
    })),
  currentVersion: () => {
    const { session } = get()
    return session.versions.find((v) => v.id === session.currentVersionId) ?? session.versions[0]
  },
}))
