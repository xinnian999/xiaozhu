// 档位展示文案（前端定）。后端只给 tier 串（free/pro/max）和每日额度数字，
// 中文名、卖点这些纯展示内容放前端，改文案不用动后端。

export const TIER_LABELS: Record<string, string> = {
  free: '免费版',
  pro: '专业版',
  max: '旗舰版',
}

export const tierLabel = (tier: string) => TIER_LABELS[tier] ?? tier

// 每档一句卖点，升级抽屉里展示
export const TIER_BLURB: Record<string, string> = {
  free: '日常体验，轻量够用',
  pro: '更高每日额度，适合频繁创作',
  max: '最高额度，重度使用无忧',
}

// 档位高低排序：只能升级（买更高档），不能降级 / 重复买当前档。
export const TIER_RANK: Record<string, number> = {
  free: 0,
  pro: 1,
  max: 2,
}
export const tierRank = (tier: string) => TIER_RANK[tier] ?? 0
