export type AskOption = string | { label: string; description?: string }

export type AskQuestion = {
  header?: string
  question: string
  options: AskOption[]
  multi?: boolean
}

function parseAskOption(v: unknown): AskOption | null {
  if (typeof v === 'string' && v.trim()) return v
  if (!v || typeof v !== 'object') return null
  const option = v as {
    label?: unknown
    description?: unknown
  }
  const label = typeof option.label === 'string' ? option.label.trim() : ''
  const description = typeof option.description === 'string'
    ? option.description.trim()
    : ''
  if (label) {
    return {
      label,
      ...(description ? { description } : {}),
    }
  }
  // 兼容已经落库的 qwen 畸形参数：它会把完整选项正文放在 description，
  // 却不返回 label。用 description 作为标签即可恢复当前等待回答的会话。
  return description ? { label: description } : null
}

export function askOptionLabel(option: AskOption): string {
  return typeof option === 'string' ? option : option.label
}

export function askOptionDescription(option: AskOption): string | undefined {
  return typeof option === 'string' ? undefined : option.description
}

export function parseAskQuestions(v: unknown): AskQuestion[] | null {
  if (!Array.isArray(v) || v.length === 0) return null
  const questions: AskQuestion[] = []
  for (const rawQuestion of v) {
    if (!rawQuestion || typeof rawQuestion !== 'object') return null
    const question = rawQuestion as {
      header?: unknown
      question?: unknown
      options?: unknown
      multi?: unknown
    }
    if (
      typeof question.question !== 'string'
      || !Array.isArray(question.options)
      || (question.header !== undefined && typeof question.header !== 'string')
    ) {
      return null
    }
    const options = question.options.map(parseAskOption)
    if (options.some((option) => option === null)) return null
    questions.push({
      question: question.question,
      options: options as AskOption[],
      ...(typeof question.header === 'string' ? { header: question.header } : {}),
      ...(typeof question.multi === 'boolean' ? { multi: question.multi } : {}),
    })
  }
  return questions
}
