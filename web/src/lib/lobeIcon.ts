import { createElement, useEffect, useState, type ReactElement } from "react";

// ============================================
// @lobehub/icons 解析工具（按需动态加载）
// ============================================
// 后端 /api/models 返回的 icon 字段是 @lobehub/icons 的「组件标识符」（不是 URL），
// 格式 "{Name}" 或 "{Name}.{Variant}"，如 "OpenAI" / "Claude.Color" / "Qwen.Color"。
//
// @lobehub/icons 整库很大（全品牌 AI 图标）。这里改成「动态 import」：它会被打成
// 独立 chunk，首屏主包不再包含它，第一次打开的白屏大幅缩短；模块级缓存 Promise，
// 整个会话只下载一次。图标纯装饰、晚一拍出现无妨，换来首屏瘦身很划算。

let _libPromise: Promise<Record<string, unknown>> | null = null;
// 加载完成后把库存到模块级缓存，组件首次挂载就能同步拿到（避免再走一次 effect/闪烁）。
let _loadedLib: Record<string, unknown> | null = null;

/** 动态加载图标库（仅首次真正下载，之后复用同一个 Promise）。 */
function loadIcons(): Promise<Record<string, unknown>> {
  if (!_libPromise) {
    _libPromise = (import("@lobehub/icons") as unknown as Promise<Record<string, unknown>>).then(
      (m) => {
        _loadedLib = m;
        return m;
      },
    );
  }
  return _libPromise;
}

/** 从已加载的库里把 lobe 标识符解析成图标元素；解析不出（库里没有）返回 null。
 *  - "OpenAI"        → <OpenAI size=.. />
 *  - "Claude.Color"  → <Claude.Color size=.. />（取组件的 .Color 静态子组件）
 */
function resolve(
  Lib: Record<string, unknown>,
  iconName: string,
  size: number,
): ReactElement | null {
  if (!iconName) return null;
  // 按 "." 拆成「组件名 . 变体名」，最多两段
  const [name, variant] = iconName.split(".");
  const Base = Lib[name];
  if (!Base) return null;
  // 有变体（如 .Color）就取静态子组件，否则用组件本身
  const Comp = variant ? (Base as Record<string, unknown>)[variant] : Base;
  // lobe 的图标多用 React.memo() 包装（返回对象而非函数），function / object 都算有效组件
  if (Comp == null || (typeof Comp !== "function" && typeof Comp !== "object"))
    return null;
  return createElement(Comp as React.ComponentType<{ size?: number }>, { size });
}

/** 异步渲染 lobe 图标的组件：库按需加载，加载完成前 / 解析不出时渲染 fallback。
 *  必须当组件用（写成 <ModelIcon .../>），不要直接函数调用——它内部用了 hooks。 */
export function ModelIcon({
  name,
  size = 16,
  fallback = null,
}: {
  name: string;
  size?: number;
  fallback?: ReactElement | null;
}): ReactElement | null {
  // 存「已加载的库」而非「解析好的元素」：库加载是一次性的异步副作用，放 effect；
  // 具体图标在 render 里按当前 name/size 现算（name 变了无需再跑 effect）。
  const [lib, setLib] = useState<Record<string, unknown> | null>(_loadedLib);
  useEffect(() => {
    if (lib) return; // 已加载就不再触发
    let alive = true;
    loadIcons()
      .then((L) => {
        if (alive) setLib(L);
      })
      .catch(() => {
        // 加载失败保持 fallback，不影响使用
      });
    return () => {
      alive = false;
    };
  }, [lib]);
  const el = lib ? resolve(lib, name, size) : null;
  return el ?? fallback;
}
