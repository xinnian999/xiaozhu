import { useState } from 'react'
import { Eye, Code2, ChevronLeft, RotateCw, ExternalLink, Terminal, Save, Undo2, Loader2 } from 'lucide-react'
import { useUIStore, type WorkTab } from '@/store/ui'
import { useSessionStore } from '@/store/session'
import { toast } from '@/lib/toast'
import { isDevRunning } from '@/lib/webcontainer'
import ShareDialog from './ShareDialog'
import styles from './index.module.scss'

// ============================================
// 工作区顶部 Tab 栏：切换 预览 / 代码
// - 预览 tab：中间显示地址栏，右侧是控制台开关
// - 代码 tab：隐藏地址栏和控制台，右侧显示「保存 / 丢弃」（有未保存草稿时）
// ============================================
const TABS: { key: WorkTab; label: string; Icon: typeof Eye }[] = [
  { key: 'preview', label: '预览', Icon: Eye },
  { key: 'code', label: '代码', Icon: Code2 },
]

export default function TabBar() {
  const workTab = useUIStore((s) => s.workTab)
  const setWorkTab = useUIStore((s) => s.setWorkTab)
  const chatCollapsed = useUIStore((s) => s.chatCollapsed)
  const toggleChat = useUIStore((s) => s.toggleChatCollapsed)
  // 控制台抽屉开关：终端按钮亮起表示当前打开
  const consoleOpen = useUIStore((s) => s.consoleOpen)
  const toggleConsole = useUIStore((s) => s.toggleConsole)
  const logCount = useUIStore((s) => s.wcLogs.length)
  // 刷新预览：bump 一下 store 里的计数，PreviewPane 会重新挂载 iframe
  const reloadPreview = useUIStore((s) => s.reloadPreview)
  // 预览只在 dev server ready 时才有 URL，没有 URL 时刷新没意义
  const wcUrl = useUIStore((s) => s.wcUrl)
  const session = useSessionStore((s) => s.session)
  const currentVersion = useSessionStore((s) => s.currentVersion())
  // 真实会话 id（分享要用它，session.id 是兼容旧组件的占位）
  const activeId = useSessionStore((s) => s.activeId)
  // 未保存草稿数量：代码 tab 且 >0 时才显示保存 / 丢弃（返回 number，selector 稳定）
  const draftCount = useSessionStore((s) => Object.keys(s.activeSession()?.drafts ?? {}).length)
  // 保存过程中的忙碌态
  const [saving, setSaving] = useState(false)
  // 分享弹窗开关
  const [shareOpen, setShareOpen] = useState(false)

  const isCode = workTab === 'code'

  // 打开分享：必须预览已经跑起来（dev server ready），否则容器里没法 vite build
  const handleShare = () => {
    if (!activeId) return
    if (!isDevRunning()) {
      toast('请等预览加载完成后再分享')
      return
    }
    setShareOpen(true)
  }

  // 保存草稿：提交后端 → upsert + 快照新版本 → 替换 files、清空草稿、追加版本卡
  // 这些都由 store 的 saveDrafts 串起来，这里只管忙碌态和 toast
  const handleSave = async () => {
    if (saving) return
    setSaving(true)
    try {
      await useSessionStore.getState().saveDrafts()
      toast('已保存为新版本')
    } catch (e) {
      toast(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }

  // 丢弃草稿：纯前端操作，编辑器立即回到已保存内容
  const handleDiscard = () => {
    if (saving) return
    useSessionStore.getState().discardDrafts()
  }

  return (
    <div className={styles.tabbar}>
      <div className={styles.left}>
        <button
          className={`${styles.collapseBtn} ${chatCollapsed ? styles.isCollapsed : ''}`}
          onClick={toggleChat}
          aria-label={chatCollapsed ? '展开侧栏' : '折叠侧栏'}
          title={chatCollapsed ? '展开侧栏' : '折叠侧栏'}
        >
          <ChevronLeft size={14} />
        </button>

        {/* Tabs */}
        <div className={styles.tabs}>
          {TABS.map(({ key, label, Icon }) => {
            const active = key === workTab
            return (
              <button
                key={key}
                className={`${styles.tab} ${active ? styles.active : ''}`}
                onClick={() => setWorkTab(key)}
              >
                <Icon size={13} />
                <span>{label}</span>
              </button>
            )
          })}
          {/* 激活态滑块的位置由 data-active 控制 */}
          <span
            className={styles.tabIndicator}
            aria-hidden
            data-active={workTab}
          />
        </div>
      </div>

      {/* 中间：preview 显示地址栏；code tab 留空占位（flex:1 撑开，把右侧按钮顶到最右） */}
      <div className={styles.center}>
        {!isCode && (
          <div className={styles.urlBar}>
            <button className={styles.urlIconBtn} aria-label="后退">
              <ChevronLeft size={13} />
            </button>
            <button className={styles.urlIconBtn} aria-label="前进">
              <ChevronLeft size={13} style={{ transform: 'rotate(180deg)' }} />
            </button>
            <button
              className={styles.urlIconBtn}
              onClick={reloadPreview}
              disabled={!wcUrl}
              aria-label="刷新预览"
              title="刷新预览"
            >
              <RotateCw size={12} />
            </button>

            <div className={styles.urlInput}>
              <span className={styles.urlBrand} aria-hidden>vb</span>
              <span className={styles.urlPath}>{session.name.toLowerCase().replace(/\s+/g, '-')}.vibuild.app</span>
              <span className={styles.urlVersionTag}>{currentVersion.id}</span>
            </div>

            <button
              className={styles.urlIconBtn}
              onClick={handleShare}
              aria-label="分享预览"
              title="分享预览"
            >
              <ExternalLink size={12} />
            </button>
          </div>
        )}
      </div>

      <div className={styles.right}>
        {isCode ? (
          // 代码 tab：有未保存草稿才显示「保存 / 丢弃」
          draftCount > 0 && (
            <>
              <button
                className={`${styles.actionBtn} ${styles.saveBtn}`}
                onClick={handleSave}
                disabled={saving}
                aria-label="保存改动"
                title="保存为新版本"
              >
                {saving ? <Loader2 size={13} className={styles.spin} /> : <Save size={13} />}
                <span>保存 ({draftCount})</span>
              </button>
              <button
                className={styles.actionBtn}
                onClick={handleDiscard}
                disabled={saving}
                aria-label="丢弃改动"
                title="丢弃所有未保存改动"
              >
                <Undo2 size={13} />
                <span>丢弃</span>
              </button>
            </>
          )
        ) : (
          // 预览 tab：控制台开关
          <button
            className={`${styles.iconBtn} ${consoleOpen ? styles.iconBtnActive : ''}`}
            onClick={toggleConsole}
            aria-label="终端"
            title={consoleOpen ? '关闭控制台' : '打开控制台'}
          >
            <Terminal size={14} />
            {logCount > 0 && !consoleOpen && (
              <span className={styles.iconBadge} aria-hidden>
                {logCount > 99 ? '99+' : logCount}
              </span>
            )}
          </button>
        )}
      </div>

      {/* 分享弹窗：打开即在容器里构建并上传，给出访客链接 */}
      {shareOpen && activeId && (
        <ShareDialog sessionId={activeId} onClose={() => setShareOpen(false)} />
      )}
    </div>
  )
}
