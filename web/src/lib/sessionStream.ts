type ActiveSessionStream = {
  controller: AbortController
  completed: Promise<void>
  complete: () => void
}

// ChatSidebar 持有真正的 AbortController；项目菜单与 session store 不应该反向依赖组件。
// 这里按 session 维护一个很小的运行时注册表，让“切换/删除项目”可以先中断并等待
// SSE 消费端的 finally 完整收尾，再修改 activeId，避免迟到事件写进新项目。
const activeStreams = new Map<string, Set<ActiveSessionStream>>()

/** 登记一条会话流，返回的 finish 必须在消费端 finally 中调用。 */
export function registerSessionStream(
  sessionId: string,
  controller: AbortController,
): () => void {
  let resolveCompleted: () => void = () => {}
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve
  })
  const entry: ActiveSessionStream = {
    controller,
    completed,
    complete: resolveCompleted,
  }
  const entries = activeStreams.get(sessionId) ?? new Set<ActiveSessionStream>()
  entries.add(entry)
  activeStreams.set(sessionId, entries)

  let finished = false
  return () => {
    if (finished) return
    finished = true
    entry.complete()
    const current = activeStreams.get(sessionId)
    current?.delete(entry)
    if (current?.size === 0) activeStreams.delete(sessionId)
  }
}

/** 中断某会话当前所有流，并等待其前端状态收尾；重复调用安全。 */
export async function interruptSessionStream(
  sessionId: string,
  reason: 'session-switch' | 'session-delete' = 'session-switch',
): Promise<boolean> {
  let interrupted = false

  // 正常 UI 同一会话只会有一条流；循环是为了覆盖极短时间内重复点击造成的并发登记。
  while (true) {
    const entries = [...(activeStreams.get(sessionId) ?? [])]
    if (entries.length === 0) return interrupted
    interrupted = true
    entries.forEach((entry) => entry.controller.abort(reason))
    await Promise.all(entries.map((entry) => entry.completed))
  }
}
