// ============================================
// 依赖快照缓存（IndexedDB）
// ============================================
// 目的：模板固定，但每次 boot WebContainer 都从网络重装 node_modules，很慢。
// 思路是「装一次，之后复用」——
//   首次安装成功后，把整个 node_modules 用 wc.export(binary) 导出成二进制快照，
//   按「依赖集合的哈希」为 key 存进 IndexedDB；
//   下次 boot 命中同一 key，直接 wc.mount(snapshot) 秒挂回去，跳过 npm install。
//
// 关键点：key 是依赖哈希、不是项目 id —— 模板固定 → 哈希恒定 →
// 这台机器上只要装过一次，之后任何项目 / 任何刷新都秒开，共享同一份 node_modules。

const DB_NAME = 'vibuild-deps-cache'
const STORE = 'node_modules'
// 缓存格式版本：快照格式 / 这套逻辑有变动时 +1，自动让旧缓存失效
const CACHE_VERSION = 'v1'

/** 打开（或初始化）IndexedDB。store 以字符串 key 存 Uint8Array 快照。 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** 把一次 IDBRequest 包成 Promise，少写一堆 onsuccess/onerror */
function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/**
 * 根据 package.json 内容算出依赖快照的缓存 key。
 * 只取 dependencies + devDependencies（排序后）参与哈希，
 * 这样改了别的字段（name/scripts…）不会让缓存失效。
 * 拿不到 package.json 或解析失败时返回 null，调用方退回普通安装。
 */
export async function computeDepsKey(packageJson: string | undefined): Promise<string | null> {
  if (!packageJson) return null
  try {
    const pkg = JSON.parse(packageJson) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    // 合并两类依赖并按 name 排序，序列化成稳定字符串
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    const stable = Object.keys(all)
      .sort()
      .map((name) => `${name}@${all[name]}`)
      .join('\n')
    // SHA-256（应用处于 COOP/COEP 安全上下文，crypto.subtle 可用）
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable))
    const hex = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    return `${CACHE_VERSION}:${hex}`
  } catch {
    return null
  }
}

/** 读快照。未命中或出错都返回 null（缓存永远是「锦上添花」，不该让 boot 失败）。 */
export async function getSnapshot(key: string): Promise<Uint8Array | null> {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE, 'readonly')
    const val = await promisify(tx.objectStore(STORE).get(key))
    db.close()
    return val instanceof Uint8Array ? val : null
  } catch {
    return null
  }
}

/** 存快照。best-effort：写失败（如配额超限）只告警，不抛。 */
export async function saveSnapshot(key: string, data: Uint8Array): Promise<void> {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE, 'readwrite')
    await promisify(tx.objectStore(STORE).put(data, key))
    db.close()
  } catch (e) {
    console.warn('依赖快照写入失败（不影响运行）', e)
  }
}

/** 删快照。用于命中的快照挂载失败（已损坏）时清掉它，下次重新安装。 */
export async function deleteSnapshot(key: string): Promise<void> {
  try {
    const db = await openDB()
    const tx = db.transaction(STORE, 'readwrite')
    await promisify(tx.objectStore(STORE).delete(key))
    db.close()
  } catch {
    // 删不掉也无所谓，下次 put 会覆盖
  }
}

// ============================================
// 预置静态快照（部署时随前端一起发布）
// ============================================
// IndexedDB 快照是 per-浏览器的：每个新用户、每台新设备的「第一次」都没有缓存，
// 仍要联网 npm install。预置快照解决这个「首次慢」——
// 把一份在 WebContainer 里导出的 node_modules 快照作为静态资源放进 public/，
// 新用户首次直接 fetch 这个文件（走我们自己的 CDN，与 npm registry 无关），
// 挂载成功后再写入各自的 IndexedDB，之后就走最快的本地缓存。
//
// 文件约定（都放在 public/ 根，部署后可通过 /deps-snapshot.* 访问）：
//   /deps-snapshot.json  —— manifest，记录该快照对应的 depsKey
//   /deps-snapshot.bin   —— node_modules 二进制快照本体
const PREBUILT_MANIFEST_URL = '/deps-snapshot.json'
const PREBUILT_SNAPSHOT_URL = '/deps-snapshot.bin'

interface PrebuiltManifest {
  // 该预置快照对应的依赖哈希（computeDepsKey 的产物）。
  // 与当前项目的 depsKey 不一致时说明模板依赖已变，预置快照作废、跳过。
  depsKey: string
}

/**
 * 尝试拉取预置静态快照。仅当其 manifest 里的 depsKey 与当前一致时才返回，
 * 避免模板依赖改了还挂旧快照。任何失败（文件不存在 / 网络错误 / 不匹配）都返回 null，
 * 让调用方安静退回 npm install。
 */
export async function fetchPrebuiltSnapshot(depsKey: string): Promise<Uint8Array | null> {
  try {
    // 先读 manifest 校验版本，匹配了再下 66MB 本体，避免无谓的大文件下载
    const manifestRes = await fetch(PREBUILT_MANIFEST_URL)
    if (!manifestRes.ok) return null
    const manifest = (await manifestRes.json()) as PrebuiltManifest
    if (manifest.depsKey !== depsKey) {
      console.warn('预置快照与当前依赖不匹配，跳过', manifest.depsKey, depsKey)
      return null
    }
    const snapRes = await fetch(PREBUILT_SNAPSHOT_URL)
    if (!snapRes.ok) return null
    const buf = await snapRes.arrayBuffer()
    return new Uint8Array(buf)
  } catch (e) {
    console.warn('拉取预置快照失败（不影响运行）', e)
    return null
  }
}
