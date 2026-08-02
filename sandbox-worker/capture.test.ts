import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { chromium } from 'playwright'

import {
  CAPTURE_VIEWPORTS,
  MAX_SCREENSHOT_BYTES,
  capturePreview,
  isAllowedCaptureUrl,
  makePreviewTreeReadable,
} from './capture.ts'

test('只把静态预览树开放为 API 可读权限', async () => {
  const previewDir = await mkdtemp(path.join(tmpdir(), 'xiaozhu-preview-mode-test-'))
  try {
    const assetsDir = path.join(previewDir, 'assets')
    const indexPath = path.join(previewDir, 'index.html')
    const assetPath = path.join(assetsDir, 'app.js')
    await mkdir(assetsDir, { mode: 0o700 })
    await writeFile(indexPath, '<main>preview</main>', { mode: 0o600 })
    await writeFile(assetPath, 'console.log("preview")', { mode: 0o600 })
    await chmod(previewDir, 0o700)

    await makePreviewTreeReadable(previewDir)

    assert.equal((await stat(previewDir)).mode & 0o777, 0o755)
    assert.equal((await stat(assetsDir)).mode & 0o777, 0o755)
    assert.equal((await stat(indexPath)).mode & 0o777, 0o644)
    assert.equal((await stat(assetPath)).mode & 0o777, 0o644)
  } finally {
    await rm(previewDir, { recursive: true, force: true })
  }
})

test('截图网络策略只放行本次本地预览与内嵌资源', () => {
  const origin = 'http://127.0.0.1:43123'
  assert.equal(isAllowedCaptureUrl(`${origin}/assets/app.js`, origin), true)
  assert.equal(isAllowedCaptureUrl('data:image/png;base64,AA==', origin), true)
  assert.equal(isAllowedCaptureUrl(`blob:${origin}/fixture`, origin), true)
  assert.equal(isAllowedCaptureUrl('about:blank', origin), true)
  assert.equal(isAllowedCaptureUrl('http://127.0.0.1:43124/private', origin), false)
  assert.equal(isAllowedCaptureUrl('https://example.com/image.png', origin), false)
  assert.equal(isAllowedCaptureUrl('file:///etc/passwd', origin), false)
})

const browserAvailable = existsSync(chromium.executablePath())

function jpegDimensions(image: Buffer): { width: number; height: number } {
  assert.deepEqual([...image.subarray(0, 2)], [0xff, 0xd8])
  assert.deepEqual([...image.subarray(-2)], [0xff, 0xd9])
  const sofMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ])
  let offset = 2
  while (offset + 4 < image.byteLength) {
    if (image[offset] !== 0xff) throw new Error('JPEG marker 无效')
    while (image[offset] === 0xff) offset += 1
    const marker = image[offset]
    offset += 1
    if (marker === 0xd9 || marker === 0xda) break
    const segmentLength = image.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > image.byteLength) {
      throw new Error('JPEG segment 长度无效')
    }
    if (sofMarkers.has(marker)) {
      return {
        height: image.readUInt16BE(offset + 3),
        width: image.readUInt16BE(offset + 5),
      }
    }
    offset += segmentLength
  }
  throw new Error('JPEG 缺少 SOF 尺寸段')
}

test('Playwright 以固定移动视口输出不超过 2MB 的 JPEG 并收集运行时错误', {
  skip: browserAvailable ? false : '本机没有安装 Playwright Chromium',
  timeout: 20_000,
}, async () => {
  const previewDir = await mkdtemp(path.join(tmpdir(), 'xiaozhu-capture-test-'))
  try {
    await writeFile(path.join(previewDir, 'index.html'), `<!doctype html>
<html><head><meta charset="UTF-8"><style>body{margin:0;background:#fff}</style></head>
<body><div id="root"><main style="width:100vw;height:100vh">截图测试</main></div>
<script>
  console.error('capture-console-sentinel')
  fetch('https://example.invalid/blocked').catch(() => {})
  history.replaceState({}, '', '/board?mode=test#today')
</script></body></html>`, 'utf8')

    const previousExecutable = process.env.SANDBOX_CHROMIUM_EXECUTABLE_PATH
    process.env.SANDBOX_CHROMIUM_EXECUTABLE_PATH = chromium.executablePath()
    const result = await (async () => {
      try {
        return await capturePreview(previewDir, 'mobile', 12_000)
      } finally {
        if (previousExecutable === undefined) {
          delete process.env.SANDBOX_CHROMIUM_EXECUTABLE_PATH
        } else {
          process.env.SANDBOX_CHROMIUM_EXECUTABLE_PATH = previousExecutable
        }
      }
    })()
    assert.equal(result.capture_error, undefined)
    assert.ok(result.screenshot)
    assert.deepEqual(
      { width: result.screenshot.width, height: result.screenshot.height },
      CAPTURE_VIEWPORTS.mobile,
    )
    assert.equal(result.screenshot.mime, 'image/jpeg')
    assert.equal(result.screenshot.device, 'mobile')
    assert.equal(result.screenshot.path, '/board?mode=test#today')
    const jpeg = Buffer.from(result.screenshot.data_base64, 'base64')
    assert.ok(jpeg.byteLength > 100)
    assert.ok(jpeg.byteLength <= MAX_SCREENSHOT_BYTES)
    assert.deepEqual(jpegDimensions(jpeg), CAPTURE_VIEWPORTS.mobile)
    assert.equal(result.runtime_errors?.length, 1)
    assert.ok(result.runtime_errors?.some((message) => (
      message.includes('console') && message.includes('capture-console-sentinel')
    )))
    assert.equal(result.runtime_errors?.some((message) => message.includes('example.invalid')), false)
  } finally {
    await rm(previewDir, { recursive: true, force: true })
  }
})
