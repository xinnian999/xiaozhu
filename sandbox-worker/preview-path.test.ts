import assert from 'node:assert/strict'
import test from 'node:test'

import { logicalPreviewPath } from './preview-path.ts'

test('首页只展示根路径，不暴露 capability', () => {
  assert.equal(
    logicalPreviewPath('/api/sandbox-preview/opaque-token/'),
    '/',
  )
})

test('保留生成应用的子路径、查询参数和 HashRouter 路由', () => {
  assert.equal(
    logicalPreviewPath(
      '/api/sandbox-preview/opaque-token/recipes/42',
      '?tab=steps',
      '#/detail',
    ),
    '/recipes/42?tab=steps#/detail',
  )
})

test('非预览网关路径保持原样', () => {
  assert.equal(logicalPreviewPath('/about', '?from=home', '#team'), '/about?from=home#team')
})
