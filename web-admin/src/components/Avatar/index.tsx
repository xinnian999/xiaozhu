import { useMemo } from 'react'
import styles from './index.module.scss'

// ============================================
// Avatar：按「头像种子」确定性地渲染头像（渐变底色 + emoji）
// ============================================
// 与主前端 web/src/components/Avatar 保持一致：后端只存一个随机种子字符串，
// 这里用它推导出固定的渐变色和 emoji —— 同一种子永远得到同一个头像，
// 不依赖任何图片资源，离线也能渲染。

// 创造主题 emoji 池（与后端 CREATION_EMOJIS 对应，靠种子取其一）
const EMOJIS = [
  '🎨', '✏️', '🖌️', '🪄', '📐', '🧩', '🛠️', '💡',
  '🚀', '🔮', '📷', '🎭', '🧵', '🪵', '⚙️', '🎬',
  '📚', '🖋️', '🌱', '🗿',
]

/** 把字符串散列成一个非负整数（简单的 djb2 变体，够用且稳定）。 */
function hashSeed(seed: string): number {
  let h = 5381
  for (let i = 0; i < seed.length; i++) {
    h = (h * 33) ^ seed.charCodeAt(i)
  }
  return Math.abs(h)
}

type AvatarProps = {
  seed: string
  /** 头像尺寸（像素），默认 28 */
  size?: number
  /** 鼠标悬停提示（一般传昵称） */
  title?: string
}

export default function Avatar({ seed, size = 28, title }: AvatarProps) {
  // 用 useMemo 避免每次渲染都重算散列
  const { gradient, emoji } = useMemo(() => {
    const h = hashSeed(seed)
    // 色相由种子决定；用两个相邻色相做斜向渐变，更有层次
    const hue = h % 360
    const hue2 = (hue + 40) % 360
    return {
      gradient: `linear-gradient(135deg, hsl(${hue} 65% 58%), hsl(${hue2} 70% 46%))`,
      emoji: EMOJIS[h % EMOJIS.length],
    }
  }, [seed])

  return (
    <span
      className={styles.avatar}
      title={title}
      // 尺寸和渐变是数据驱动的动态值，按规范保留内联 style
      style={{ width: size, height: size, background: gradient, fontSize: size * 0.5 }}
      aria-hidden
    >
      {emoji}
    </span>
  )
}
