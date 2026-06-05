import { createElement, type ReactElement } from "react";
import * as LobeIcons from "@lobehub/icons";

// ============================================
// @lobehub/icons 解析工具
// ============================================
// 后端 /api/models 返回的 icon 字段是 @lobehub/icons 的「组件标识符」（不是 URL），
// 格式 "{Name}" 或 "{Name}.{Variant}"，如 "OpenAI" / "Claude.Color" / "Qwen.Color"。
// 这里把这个字符串解析成对应的 React 图标组件。

/** 把 lobe 标识符解析成图标元素。解析不出（库里没有这个组件）则返回 null。
 *  - "OpenAI"        → <OpenAI size=.. />
 *  - "Claude.Color"  → <Claude.Color size=.. />（取组件的 .Color 静态子组件）
 */
export function getLobeHubIcon(
  iconName: string,
  size = 16,
): ReactElement | null {
  if (!iconName) return null;
  // 按 "." 拆成「组件名 . 变体名」，最多两段
  const [name, variant] = iconName.split(".");
  // lobe 的图标都是具名导出，用字符串名从命名空间里取
  const Base = (LobeIcons as Record<string, unknown>)[name];
  if (!Base) return null;
  // 有变体（如 .Color）就取静态子组件，否则用组件本身
  const Comp = variant ? (Base as Record<string, unknown>)[variant] : Base;
  // lobe 的图标多用 React.memo() 包装，memo 返回的是「对象」而非函数，
  // 所以这里不能只认 function，function（普通组件）和 object（memo/forwardRef）都算有效组件
  if (Comp == null || (typeof Comp !== "function" && typeof Comp !== "object"))
    return null;
  return createElement(Comp as React.ComponentType<{ size?: number }>, {
    size,
  });
}
