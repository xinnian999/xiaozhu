import assert from 'node:assert/strict'
import test from 'node:test'

import {
  askOptionLabel,
  parseAskQuestions,
} from '../src/components/ChatSidebar/MessageBubble/askUserData.ts'

test('description-only 的线上历史选项可恢复为可选择标签', () => {
  const questions = parseAskQuestions([
    {
      header: '功能模块',
      multi: true,
      question: '你希望图书管理系统包含哪些功能？',
      options: [
        {
          description: '添加新书、编辑图书信息、删除图书',
          description_en: 'Add, edit, delete books',
        },
      ],
    },
  ])

  assert.ok(questions)
  assert.equal(
    askOptionLabel(questions[0].options[0]),
    '添加新书、编辑图书信息、删除图书',
  )
})

test('完全不可展示的选项仍会被拒绝', () => {
  assert.equal(
    parseAskQuestions([
      {
        question: '选择功能',
        multi: true,
        options: [{ description_en: 'Search' }],
      },
    ]),
    null,
  )
})
