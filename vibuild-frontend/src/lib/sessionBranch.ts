import type { Message, Session, Version } from '@/types/project'

/** 默认主线分支 id */
export const MAIN_BRANCH = 'main'

export function getBranchId(entity: { branchId?: string }): string {
  return entity.branchId ?? MAIN_BRANCH
}

/** 从根到目标版本的祖先链（含自身） */
export function getVersionAncestry(versions: Version[], versionId: string): string[] {
  const byId = new Map(versions.map((v) => [v.id, v]))
  const chain: string[] = []
  let cur: string | undefined = versionId
  while (cur) {
    chain.unshift(cur)
    cur = byId.get(cur)?.parentVersionId
  }
  return chain
}

export function isDescendantOf(
  versions: Version[],
  ancestorId: string,
  descendantId: string,
): boolean {
  if (ancestorId === descendantId) return false
  return getVersionAncestry(versions, descendantId).includes(ancestorId)
}

/** 同一分支上、当前版本之后的后续版本（未被删除，可随时切回） */
export function getLaterVersionsOnBranch(session: Session, versionId: string): Version[] {
  const current = session.versions.find((v) => v.id === versionId)
  if (!current) return []
  const branch = getBranchId(current)
  return session.versions
    .filter(
      (v) =>
        getBranchId(v) === branch &&
        isDescendantOf(session.versions, versionId, v.id),
    )
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** 从当前版本祖先处分出的其它分支 */
export type AlternateBranch = {
  branchId: string
  forkFromVersionId: string
  versions: Version[]
  /** 该分支上最新的版本（用于一键跳转） */
  tipVersionId: string
}

export function getAlternateBranches(
  session: Session,
  versionId: string,
): AlternateBranch[] {
  const ancestry = new Set(getVersionAncestry(session.versions, versionId))
  const current = session.versions.find((v) => v.id === versionId)
  if (!current) return []

  const currentBranch = getBranchId(current)
  const byBranch = new Map<string, { forkFrom: string; versions: Version[] }>()

  for (const v of session.versions) {
    if (getBranchId(v) === currentBranch) continue
    if (!v.parentVersionId || !ancestry.has(v.parentVersionId)) continue

    const bid = getBranchId(v)
    const entry = byBranch.get(bid) ?? { forkFrom: v.parentVersionId, versions: [] }
    entry.versions.push(v)
    byBranch.set(bid, entry)
  }

  return [...byBranch.entries()].map(([branchId, { forkFrom, versions }]) => {
    const sorted = [...versions].sort((a, b) => b.createdAt - a.createdAt)
    return {
      branchId,
      forkFromVersionId: forkFrom,
      versions: sorted,
      tipVersionId: sorted[0].id,
    }
  })
}

/** 在当前版本上继续对话是否会创建新分支（因同分支上已有更晚版本） */
export function willForkOnContinue(session: Session, versionId: string): boolean {
  return getLaterVersionsOnBranch(session, versionId).length > 0
}

/**
 * 侧栏展示：当前分支上、截至当前版本的消息（仅视图裁剪，不删数据）
 */
export function getMessagesForVersion(session: Session, versionId: string): Message[] {
  const version = session.versions.find((v) => v.id === versionId)
  if (!version) return []

  const branch = getBranchId(version)
  const branchMessages = session.messages
    .filter((m) => getBranchId(m) === branch)
    .sort((a, b) => a.ts - b.ts)

  const ancestrySet = new Set(getVersionAncestry(session.versions, versionId))
  const result: Message[] = []

  for (const msg of branchMessages) {
    if (msg.producedVersionId) {
      if (!ancestrySet.has(msg.producedVersionId)) break
      result.push(msg)
      if (msg.producedVersionId === versionId) break
    } else {
      result.push(msg)
    }
  }
  return result
}

/** 取分支显示名：主线直接叫"主线"，其它分支带上"自某版本分出"的提示 */
export function getBranchLabel(session: Session, branchId: string): string {
  if (branchId === MAIN_BRANCH) return '主线'
  // 找该分支上最早一个版本的 parent，作为分叉点
  const branchVersions = session.versions
    .filter((v) => getBranchId(v) === branchId)
    .sort((a, b) => a.createdAt - b.createdAt)
  const forkFromId = branchVersions[0]?.parentVersionId
  return forkFromId ? `分支 · 自 ${forkFromId} 分出` : '分支'
}

// ============================================
// 版本树（用于版本历史的缩进树渲染）
// ============================================
// 规则：
//  - 主线节点：parentVersionId 为空，或 parentVersionId 所在分支与自己相同
//  - 分支节点：parentVersionId 所在分支与自己不同（即"从其它分支分叉出来"的版本）
//  - children 顺序：先放同分支的延续，再放分叉出去的其它分支根
//  - 同层按 createdAt 升序，让阅读顺序贴合"时间往下走"

export type VersionTreeNode = {
  version: Version
  /** 相对于父节点是否跨越了分支（用于画分叉视觉） */
  isBranchRoot: boolean
  /** 缩进层级，根为 0；分叉一次 +1 */
  depth: number
  children: VersionTreeNode[]
}

/**
 * 把 session.versions 构造成版本树。
 * 返回所有"根版本"（parentVersionId 为空的版本，通常只有 1 个）。
 */
export function buildVersionTree(session: Session): VersionTreeNode[] {
  const versions = [...session.versions].sort((a, b) => a.createdAt - b.createdAt)
  const childrenOf = new Map<string, Version[]>()
  const roots: Version[] = []

  for (const v of versions) {
    if (v.parentVersionId) {
      const arr = childrenOf.get(v.parentVersionId) ?? []
      arr.push(v)
      childrenOf.set(v.parentVersionId, arr)
    } else {
      roots.push(v)
    }
  }

  // 把子节点排序：分叉子树先（紧贴父节点显示），同分支延续后（继续主干）
  // 否则深度优先会把主线走完才回头处理分叉，分支节点会被推到主线末尾，
  // 视觉上看起来像是从错误的版本分出去的。
  const buildNode = (version: Version, depth: number, parent?: Version): VersionTreeNode => {
    const isBranchRoot = !!parent && getBranchId(parent) !== getBranchId(version)
    const rawChildren = childrenOf.get(version.id) ?? []
    const sameBranch = rawChildren
      .filter((c) => getBranchId(c) === getBranchId(version))
      .sort((a, b) => a.createdAt - b.createdAt)
    const forks = rawChildren
      .filter((c) => getBranchId(c) !== getBranchId(version))
      .sort((a, b) => a.createdAt - b.createdAt)

    // 同分支后代不增加深度；分叉子树 depth+1
    const children: VersionTreeNode[] = [
      ...forks.map((c) => buildNode(c, depth + 1, version)),
      ...sameBranch.map((c) => buildNode(c, depth, version)),
    ]
    return { version, isBranchRoot, depth, children }
  }

  return roots.map((r) => buildNode(r, 0))
}

/** 把版本树扁平化为渲染列表（深度优先，保留 depth / isBranchRoot） */
export type FlatTreeRow = {
  version: Version
  depth: number
  isBranchRoot: boolean
  /** 是否是同一父节点下的最后一个子节点（用于画 └ / ├） */
  isLastChild: boolean
}

export function flattenVersionTree(nodes: VersionTreeNode[]): FlatTreeRow[] {
  const out: FlatTreeRow[] = []
  const walk = (list: VersionTreeNode[]) => {
    list.forEach((node, idx) => {
      out.push({
        version: node.version,
        depth: node.depth,
        isBranchRoot: node.isBranchRoot,
        isLastChild: idx === list.length - 1,
      })
      if (node.children.length > 0) walk(node.children)
    })
  }
  walk(nodes)
  return out
}
