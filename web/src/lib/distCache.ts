// ============================================
// dist 产物缓存（IndexedDB / L2）
// ============================================
// webcontainer.ts 里那个内存 Map 是 L1：快、无异步，但刷新页面就没了。
// 这里是 L2：把每次成功构建的 dist 产物持久化进 IndexedDB，刷新 / 重开浏览器后仍在。
// 命中后既省掉切版本的几秒 build，连刷新后首屏 boot 的那次 build 也能跳过（见 bootAndRun）。
//
// key = 源文件内容哈希（见 webcontainer.computeFilesKey），同一份源文件 → 同一份 dist。
// 和依赖快照缓存（xiaozhu-deps-cache）分库，各管各的、互不影响。
//
// 记录形如 { key, files, usedAt }：usedAt 用于「超量淘汰」——dist 按内容寻址，
// 用户生成的版本越多、不同内容越多，条目会无限增长，所以按最近使用淘汰封顶。

import type { BuiltFile } from '@/lib/webcontainer'

const DB_NAME = 'xiaozhu-dist-cache'
const STORE = 'dist'
// 最多持久化多少份 dist。超了按 usedAt 升序（最久未用）淘汰。dist 本身不大，给宽松些。
const MAX_ENTRIES = 24

type DistRecord = { key: string; files: BuiltFile[]; usedAt: number }

/** 打开（或初始化）IndexedDB。记录用内联主键 key，并建 usedAt 索引供淘汰时排序。 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'key' })
        os.createIndex('usedAt', 'usedAt')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** 把一次 IDBRequest 包成 Promise，少写一堆 onsuccess/onerror。 */
function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** 读一份持久化的 dist。命中顺手刷新 usedAt（best-effort 触摸，失败无所谓）。
 *  未命中或出错都返回 null —— 缓存永远是「锦上添花」，不该让预览失败。 */
export async function getDist(key: string): Promise<BuiltFile[] | null> {
  try {
    const db = await openDB()
    // 用 readwrite 是为了命中后顺手把 usedAt 触摸成「现在」（LRU）
    const tx = db.transaction(STORE, 'readwrite')
    const os = tx.objectStore(STORE)
    const rec = (await promisify(os.get(key))) as DistRecord | undefined
    if (rec) {
      rec.usedAt = Date.now()
      os.put(rec)  // 触摸最近使用，不必 await
    }
    db.close()
    return rec?.files ?? null
  } catch {
    return null
  }
}

/** 持久化一份 dist。写完做超量淘汰：按 usedAt 升序删最老的，直到不超上限。
 *  best-effort：写失败（配额超限等）只告警，不抛 —— 调用方本就有 L1 内存缓存兜底。 */
export async function putDist(key: string, files: BuiltFile[]): Promise<void> {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE, 'readwrite')
    const os = tx.objectStore(STORE)
    await promisify(os.put({ key, files, usedAt: Date.now() } satisfies DistRecord))

    // 超量淘汰：用 usedAt 索引升序游标，从最久未用开始删，删到不超上限为止。
    const count = await promisify(os.count())
    let toDelete = count - MAX_ENTRIES
    if (toDelete > 0) {
      await new Promise<void>((resolve, reject) => {
        const cursorReq = os.index('usedAt').openCursor()
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result
          if (!cursor || toDelete <= 0) {
            resolve()
            return
          }
          cursor.delete()
          toDelete--
          cursor.continue()
        }
        cursorReq.onerror = () => reject(cursorReq.error)
      })
    }
    db.close()
  } catch (e) {
    console.warn('dist 缓存持久化失败（不影响运行）', e)
  }
}
