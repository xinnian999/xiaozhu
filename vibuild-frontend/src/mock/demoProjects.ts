import type { FileMap, Session } from '@/types/project'
import { personalBlog, personalBlogBlankFiles } from './personalBlog'
import { shopLanding } from './shopLanding'
import { opsDashboard } from './opsDashboard'

// ============================================
// demo 项目聚合导出
// ============================================
// 类型定义已迁至 @/types/project，本文件只负责把三个 demo session 聚合起来。
// 单一项目的内容请改对应子文件：personalBlog.ts / shopLanding.ts / opsDashboard.ts

/** 所有 demo 项目（按 updatedAt 倒序，最新的在前） */
export const demoSessions: Session[] = [personalBlog, shopLanding, opsDashboard].sort(
  (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
)

/** 默认打开的 demo 项目（列表第一个） */
export const demoSession: Session = demoSessions[0]

/** 空白项目模板（新建项目时使用） */
export function createBlankProject(name = '未命名项目'): Session {
  const now = Date.now()
  const files: FileMap = personalBlogBlankFiles
  return {
    id: `project-${now}`,
    name,
    description: '新建空白项目',
    currentVersionId: 'v1',
    createdAt: now,
    updatedAt: now,
    versions: [
      {
        id: 'v1',
        label: '初始版本',
        summary: '新建项目',
        branchId: 'main',
        createdAt: now,
        diff: { added: 0, removed: 0 },
        authorRole: 'user',
        files,
      },
    ],
    messages: [],
  }
}

/** @deprecated 使用 demoSession；保留别名便于迁移 */
export const demoProject = demoSession

// —— 类型 re-export（兼容旧 import 路径，建议新代码从 @/types/project 直接导入） ——
export type {
  FileMap,
  AuthorRole,
  Version,
  Message,
  Session,
} from '@/types/project'
