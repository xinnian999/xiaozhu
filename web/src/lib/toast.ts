// toast 静态方法：可在任意非组件文件（store、api、工具函数）里调用
// 原理：zustand store 暴露了 .getState()，在 React 树外也能直接访问
import { useUIStore } from '@/store/ui'

export const toast = (msg: string) => useUIStore.getState().pushToast(msg)
