import { create } from 'zustand'
import { demoSessions, demoSession, createBlankProject } from '@/mock/demoProjects'
import type { Session, Version } from '@/types/project'
import { useEditorStore } from '@/store/editor'

// ============================================
// Session store：本地项目 + 版本切换
// ============================================

type SessionState = {
  /** 本机已打开的项目列表 */
  projects: Session[]
  session: Session
  setCurrentProject: (projectId: string) => void
  /** 切换到某个版本 */
  setCurrentVersion: (versionId: string) => void
  /** 新建空白项目并切换过去 */
  createProject: () => Session
  /** 取当前版本对象 */
  currentVersion: () => Version
}

function syncProjectInList(projects: Session[], session: Session): Session[] {
  return projects.map((p) => (p.id === session.id ? session : p))
}

export const useSessionStore = create<SessionState>((set, get) => ({
  projects: demoSessions,
  session: demoSession,

  setCurrentProject: (projectId) => {
    const project = get().projects.find((p) => p.id === projectId)
    if (!project || project.id === get().session.id) return
    useEditorStore.getState().reset()
    set({ session: project })
  },

  setCurrentVersion: (versionId) => {
    const { session } = get()
    if (versionId === session.currentVersionId) return
    const next: Session = { ...session, currentVersionId: versionId }
    set((s) => ({
      session: next,
      projects: syncProjectInList(s.projects, next),
    }))
  },

  createProject: () => {
    const project = createBlankProject()
    useEditorStore.getState().reset()
    set((s) => ({
      projects: [project, ...s.projects],
      session: project,
    }))
    return project
  },

  currentVersion: () => {
    const { session } = get()
    return session.versions.find((v) => v.id === session.currentVersionId) ?? session.versions[0]
  },
}))
