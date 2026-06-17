import { useCallback, useRef, useState } from 'react'
import { ChevronDown, Check, Bot } from 'lucide-react'
import { useSessionStore } from '@/store/session'
import { useClickOutside } from '@/hooks/useClickOutside'
import { getLobeHubIcon } from '@/lib/lobeIcon'
import styles from './index.module.scss'

// ============================================
// 模型选择下拉框
// ============================================
// 放在聊天输入框工具栏里。模型清单由 App 启动时 loadModels 拉好存进 store，
// 这里只负责「展示 + 选择」。选中的模型存 store.selectedModel，发消息时带上。
export default function ModelSelector() {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const models = useSessionStore((s) => s.models)
  const selectedModel = useSessionStore((s) => s.selectedModel)
  const setSelectedModel = useSessionStore((s) => s.setSelectedModel)

  const close = useCallback(() => setOpen(false), [])
  useClickOutside(rootRef, close)

  const handleSelect = (id: string) => {
    setSelectedModel(id)
    close()
  }

  // 当前选中模型的元信息，用来在触发按钮上显示图标 + 名字
  const current = models.find((m) => m.id === selectedModel)

  // 模型清单还没加载出来时不渲染，避免出现空按钮
  if (models.length === 0) return null

  // lobe 解析不出图标时用 lucide 的 <Bot> 兜底
  const renderIcon = (icon: string, size: number) =>
    getLobeHubIcon(icon, size) ?? <Bot size={size} className={styles.fallbackIcon} />

  return (
    <div className={styles.selector} ref={rootRef}>
      <button
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        {current && <span className={styles.triggerIcon}>{renderIcon(current.icon, 15)}</span>}
        <span className={styles.triggerLabel}>{current?.label ?? '选择模型'}</span>
        <ChevronDown size={12} className={styles.caret} />
      </button>

      {open && (
        <div className={styles.panel} role="menu" aria-label="选择模型">
          <ul className={styles.list}>
            {models.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  role="menuitem"
                  className={`${styles.item} ${m.id === selectedModel ? styles.itemActive : ''}`}
                  onClick={() => handleSelect(m.id)}
                >
                  <span className={styles.itemIcon}>{renderIcon(m.icon, 16)}</span>
                  <span className={styles.itemLabel}>{m.label}</span>
                  {/* 付费倍率：一轮扣几点（1x / 2x），让用户选模型时心里有数 */}
                  <span className={styles.itemCost}>{m.cost}x</span>
                  {m.id === selectedModel && <Check size={14} className={styles.itemCheck} />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
