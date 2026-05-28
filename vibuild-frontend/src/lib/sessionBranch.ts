import type { Message, Session, Version } from '@/mock/demoProjects'

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

export type VersionBranchGroup = {
  branchId: string
  label: string
  versions: Version[]
}

/** 版本菜单：按分支分组，组内按时间倒序 */
export function groupVersionsByBranch(session: Session): VersionBranchGroup[] {
  const byBranch = new Map<string, Version[]>()
  for (const v of session.versions) {
    const bid = getBranchId(v)
    const list = byBranch.get(bid) ?? []
    list.push(v)
    byBranch.set(bid, list)
  }

  const groups: VersionBranchGroup[] = [...byBranch.entries()].map(([branchId, versions]) => {
    const sorted = [...versions].sort((a, b) => b.createdAt - a.createdAt)
    const forkFrom = versions.find((v) => v.parentVersionId)?.parentVersionId
    const forkLabel = forkFrom
      ? session.versions.find((v) => v.id === forkFrom)?.id ?? forkFrom
      : null

    let label = '主线'
    if (branchId !== MAIN_BRANCH) {
      label = forkLabel ? `分支 · 自 ${forkLabel} 分出` : '分支'
    }

    return { branchId, label, versions: sorted }
  })

  groups.sort((a, b) => {
    if (a.branchId === MAIN_BRANCH) return -1
    if (b.branchId === MAIN_BRANCH) return 1
    const aTip = a.versions[0]?.createdAt ?? 0
    const bTip = b.versions[0]?.createdAt ?? 0
    return bTip - aTip
  })

  return groups
}

export function getBranchLabel(session: Session, branchId: string): string {
  return groupVersionsByBranch(session).find((g) => g.branchId === branchId)?.label ?? '分支'
}
