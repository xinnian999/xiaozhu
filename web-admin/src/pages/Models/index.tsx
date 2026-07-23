import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Table,
  Button,
  Drawer,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Space,
  Tag,
  Popconfirm,
  Modal,
  Progress,
  Spin,
  App as AntdApp,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  listModels,
  listModelProviders,
  exportModels,
  importModels,
  createModel,
  updateModel,
  deleteModel,
  setModelsEnabled,
  testModelCapability,
  type AdminModel,
  type ModelCapabilityTestResult,
  type ModelExportBundle,
  type ModelExportItem,
  type ModelProvider,
  type ModelTestCapability,
} from '@/lib/api'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpToLine,
  BrainCircuit,
  CircleCheck,
  CircleHelp,
  CircleMinus,
  CircleX,
  ImageIcon,
  RotateCw,
  Radar,
  Wrench,
  Wifi,
  type LucideIcon,
} from 'lucide-react'
import { ModelIcon } from '@/lib/lobeIcon'
import styles from './index.module.scss'

const CAPABILITY_TESTS: Array<{
  key: ModelTestCapability
  label: string
  description: string
  icon: LucideIcon
}> = [
  { key: 'connectivity', label: '连通性', description: '验证地址、密钥与模型名称可正常响应', icon: Wifi },
  { key: 'vision', label: '识图能力', description: '发送一张已知颜色图片并校验识别结果', icon: ImageIcon },
  {
    key: 'thinking',
    label: '思考能力',
    description: '测试思考信号、推理内容与关闭思考开关',
    icon: BrainCircuit,
  },
  { key: 'tools', label: '工具调用', description: '要求模型生成符合规范的函数调用', icon: Wrench },
]

type TestItemState = {
  /** skipped 仅是前端编排状态，不改变后端能力测试契约。 */
  phase: 'pending' | 'running' | 'done' | 'skipped'
  result?: ModelCapabilityTestResult
  message?: string
}

type BatchModelTestState = {
  phase: 'pending' | 'running' | 'done'
  currentCapability?: ModelTestCapability
  completed: number
  passed: number
  unsupported: number
  failed: number
  summary?: string
}

function emptyTestStates(): Record<ModelTestCapability, TestItemState> {
  return Object.fromEntries(
    CAPABILITY_TESTS.map((item) => [item.key, { phase: 'pending' }]),
  ) as Record<ModelTestCapability, TestItemState>
}

function capabilityErrorResult(
  capability: ModelTestCapability,
  error: unknown,
): ModelCapabilityTestResult {
  const rawReason = error instanceof Error ? error.message : '未知错误'
  const timeoutMatch = rawReason.match(/timeout of (\d+)ms exceeded/i)
  return {
    capability,
    status: 'failed',
    message: timeoutMatch
      ? `等待模型响应超时（${Math.round(Number(timeoutMatch[1]) / 1000)} 秒）`
      : rawReason,
    latency_ms: null,
    details: [],
  }
}

/** 解析导入 JSON：支持标准导出包，也兼容直接的 models 数组。 */
function parseImportFile(json: unknown): ModelExportItem[] {
  if (Array.isArray(json)) {
    return json as ModelExportItem[]
  }
  if (
    json &&
    typeof json === 'object' &&
    'models' in json &&
    Array.isArray((json as ModelExportBundle).models)
  ) {
    return (json as ModelExportBundle).models
  }
  throw new Error('文件格式不正确，请使用本系统导出的 JSON')
}

/** 旧版“自定义 / 中转站”已并入 OpenAI 厂商。 */
function normalizeProviderId(provider?: string): string {
  return !provider || provider === 'custom_openai' ? 'openai' : provider
}

// ============================================
// LLM 模型管理页（对齐 admin.py 的 LlmModelAdmin：增删改 + 启停批量）
// ============================================
export default function Models() {
  const { message, modal } = AntdApp.useApp()
  const [data, setData] = useState<AdminModel[]>([])
  const [providers, setProviders] = useState<ModelProvider[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [reorderingId, setReorderingId] = useState<string | null>(null)
  const [testTarget, setTestTarget] = useState<AdminModel | null>(null)
  const [testStates, setTestStates] = useState(emptyTestStates)
  const [testsRunning, setTestsRunning] = useState(false)
  const testRunRef = useRef(0)
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchStates, setBatchStates] = useState<Record<string, BatchModelTestState>>({})
  const batchRunRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  /** 新建/复制时追加到列表末尾的排序权重 */
  const nextSortOrder = () =>
    data.reduce((max, m) => Math.max(max, m.sort_order), -1) + 1

  // 新建 / 编辑抽屉；editing=null 且 open=true 表示新建或复制
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<AdminModel | null>(null)
  const [isCopy, setIsCopy] = useState(false)
  const [form] = Form.useForm()
  const selectedProviderId = Form.useWatch('provider', form) as string | undefined
  const providerById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  )
  const selectedProvider = selectedProviderId
    ? providerById.get(selectedProviderId)
    : undefined

  const providerForModel = (model: AdminModel) =>
    providerById.get(normalizeProviderId(model.provider))
  const logoForModel = (model: AdminModel) => providerForModel(model)?.logo || model.logo || 'OpenAI'

  /** 根据已有 ID 生成不冲突的复制用主键（如 foo → foo-copy，已占用则 foo-copy-2）。 */
  const suggestCopyId = (sourceId: string) => {
    const existing = new Set(data.map((m) => m.id))
    let candidate = `${sourceId}-copy`
    let n = 2
    while (existing.has(candidate)) {
      candidate = `${sourceId}-copy-${n}`
      n += 1
    }
    return candidate
  }

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [modelsResult, providersResult] = await Promise.allSettled([
        listModels(),
        listModelProviders(),
      ])
      // 厂商目录是模型列表的增强信息。即使目录接口暂时不可用（例如滚动发布
      // 期间前后端版本短暂不一致），仍展示模型并用记录中的 provider/logo 降级。
      if (modelsResult.status === 'fulfilled') {
        setData(modelsResult.value)
      }
      if (providersResult.status === 'fulfilled') {
        setProviders(providersResult.value)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // 初次挂载需立即拉取服务端模型清单；fetchData 的引用由 useCallback 保持稳定。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchData()
  }, [fetchData])

  const openCreate = () => {
    setEditing(null)
    setIsCopy(false)
    form.resetFields()
    form.setFieldsValue({
      provider: 'openai',
      enabled: true,
      cost: 1,
    })
    setOpen(true)
  }

  const openEdit = (model: AdminModel) => {
    setEditing(model)
    setIsCopy(false)
    form.setFieldsValue({
      id: model.id,
      provider: normalizeProviderId(model.provider),
      base_url: model.base_url,
      api_key: '', // 敏感值不回填脱敏串；留空表示不改
      cost: model.cost,
      enabled: model.enabled,
    })
    setOpen(true)
  }

  // 复制：以当前行为模板打开新建抽屉，主键自动加 -copy 后缀避免冲突
  const openCopy = (model: AdminModel) => {
    setEditing(null)
    setIsCopy(true)
    form.resetFields()
    form.setFieldsValue({
      id: suggestCopyId(model.id),
      provider: normalizeProviderId(model.provider),
      base_url: model.base_url,
      api_key: '', // 列表里是脱敏值，复制后需重新填写
      cost: model.cost,
      enabled: model.enabled,
    })
    setOpen(true)
  }

  const closeDrawer = () => {
    setOpen(false)
    setIsCopy(false)
  }

  const handleProviderChange = (providerId: string) => {
    const provider = providerById.get(providerId)
    const currentBaseUrl = String(form.getFieldValue('base_url') ?? '').trim()
    // 厂商只决定请求适配器与推荐配置，不应破坏用户填写的中转地址或密钥。
    // 仅在 Base URL 尚未填写时补充推荐端点；API Key 始终原样保留。
    if (!currentBaseUrl && provider?.default_base_url) {
      form.setFieldValue('base_url', provider.default_base_url)
    }
  }

  const submit = async () => {
    const values = await form.validateFields()
    if (editing) {
      // 编辑：api_key 留空表示不改，去掉该字段避免把 key 覆盖成空
      const payload = { ...values }
      if (!payload.api_key) delete payload.api_key
      delete payload.id
      await updateModel(editing.id, payload)
      message.success('已保存')
    } else {
      // 新建/复制默认排到列表末尾，不再手填 sort_order
      await createModel({ ...values, sort_order: nextSortOrder() })
      message.success(isCopy ? '已复制创建' : '已创建')
    }
    closeDrawer()
    fetchData()
  }

  const onDelete = async (id: string) => {
    await deleteModel(id)
    message.success('已删除')
    fetchData()
  }

  const batchSetEnabled = async (enabled: boolean) => {
    if (selectedIds.length === 0) return
    await setModelsEnabled(selectedIds, enabled)
    message.success(enabled ? '已启用所选' : '已禁用所选')
    setSelectedIds([])
    fetchData()
  }

  // 导出全部模型配置为 JSON 文件（含明文 api_key，仅管理员可调用）
  const handleExport = async () => {
    try {
      const bundle = await exportModels()
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `xiaozhu-models-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      message.success(`已导出 ${bundle.models.length} 个模型`)
    } catch {
      /* http 拦截器已提示 */
    }
  }

  // 从 JSON 文件导入模型配置（按 id upsert）
  const handleImportClick = () => fileInputRef.current?.click()

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    try {
      const json = JSON.parse(await file.text()) as unknown
      const models = parseImportFile(json)
      if (models.length === 0) {
        message.warning('文件里没有模型配置')
        return
      }
      for (const m of models) {
        if (!m.id) {
          throw new Error(`模型配置缺少 id：${m.id ?? '（无 id）'}`)
        }
      }

      modal.confirm({
        title: '确认导入模型配置',
        content: `将导入 ${models.length} 个模型。已存在的模型 ID 会被覆盖，是否继续？`,
        okText: '导入',
        cancelText: '取消',
        onOk: async () => {
          const result = await importModels(models)
          message.success(`导入完成：新建 ${result.created} 个，更新 ${result.updated} 个`)
          fetchData()
        },
      })
    } catch (err) {
      message.error(err instanceof Error ? err.message : '文件解析失败')
    }
  }

  // 行内排序：与相邻项交换 sort_order，置顶则压到当前最小值之前
  const handleReorder = async (id: string, action: 'up' | 'down' | 'top') => {
    const index = data.findIndex((m) => m.id === id)
    if (index < 0) return

    setReorderingId(id)
    try {
      if (action === 'up') {
        if (index === 0) return
        const current = data[index]
        const prev = data[index - 1]
        await Promise.all([
          updateModel(current.id, { sort_order: prev.sort_order }),
          updateModel(prev.id, { sort_order: current.sort_order }),
        ])
        message.success('已上移')
      } else if (action === 'down') {
        if (index === data.length - 1) return
        const current = data[index]
        const next = data[index + 1]
        await Promise.all([
          updateModel(current.id, { sort_order: next.sort_order }),
          updateModel(next.id, { sort_order: current.sort_order }),
        ])
        message.success('已下移')
      } else {
        if (index === 0) return
        const current = data[index]
        const topOrder = data[0].sort_order
        await updateModel(current.id, { sort_order: topOrder - 1 })
        message.success('已置顶')
      }
      fetchData()
    } catch {
      /* http 拦截器已提示 */
    } finally {
      setReorderingId(null)
    }
  }

  const runCapability = async (
    row: AdminModel,
    capability: ModelTestCapability,
    runId: number,
  ): Promise<ModelCapabilityTestResult | null> => {
    setTestStates((prev) => ({ ...prev, [capability]: { phase: 'running' } }))
    try {
      const result = await testModelCapability(row.id, capability)
      if (testRunRef.current !== runId) return null
      setTestStates((prev) => ({ ...prev, [capability]: { phase: 'done', result } }))
      return result
    } catch (error) {
      if (testRunRef.current !== runId) return null
      const result = capabilityErrorResult(capability, error)
      setTestStates((prev) => ({
        ...prev,
        [capability]: { phase: 'done', result },
      }))
      return result
    }
  }

  const runAllTests = async (row: AdminModel) => {
    const runId = ++testRunRef.current
    setTestStates(emptyTestStates())
    setTestsRunning(true)
    for (const item of CAPABILITY_TESTS) {
      if (testRunRef.current !== runId) return
      const result = await runCapability(row, item.key, runId)
      if (testRunRef.current !== runId) return
      if (item.key === 'connectivity' && result?.status !== 'passed') {
        const skippedMessage = '未执行：请先修复连通性，再重新测试全部能力。'
        setTestStates((prev) => {
          const next = { ...prev }
          for (const remaining of CAPABILITY_TESTS) {
            if (remaining.key !== 'connectivity') {
              next[remaining.key] = { phase: 'skipped', message: skippedMessage }
            }
          }
          return next
        })
        break
      }
    }
    await fetchData()
    if (testRunRef.current === runId) setTestsRunning(false)
  }

  const openFullTest = (row: AdminModel) => {
    if (batchRunning) return
    setTestTarget(row)
    void runAllTests(row)
  }

  const closeFullTest = () => {
    testRunRef.current += 1
    setTestsRunning(false)
    setTestTarget(null)
  }

  const retryCapability = async (capability: ModelTestCapability) => {
    if (!testTarget || testsRunning) return
    const runId = ++testRunRef.current
    setTestsRunning(true)
    await runCapability(testTarget, capability, runId)
    if (capability === 'vision' || capability === 'thinking') await fetchData()
    if (testRunRef.current === runId) setTestsRunning(false)
  }

  const updateBatchModel = (
    modelId: string,
    update: Partial<BatchModelTestState>,
  ) => {
    setBatchStates((prev) => ({
      ...prev,
      [modelId]: { ...prev[modelId], ...update },
    }))
  }

  const probeOneModel = async (row: AdminModel, runId: number) => {
    let completed = 0
    let passed = 0
    let unsupported = 0
    let failed = 0
    const failureMessages: string[] = []

    updateBatchModel(row.id, { phase: 'running' })
    for (const item of CAPABILITY_TESTS) {
      if (batchRunRef.current !== runId) return
      updateBatchModel(row.id, { currentCapability: item.key })

      let result: ModelCapabilityTestResult
      try {
        result = await testModelCapability(row.id, item.key)
      } catch (error) {
        result = capabilityErrorResult(item.key, error)
      }
      if (batchRunRef.current !== runId) return

      completed += 1
      if (result.status === 'passed') passed += 1
      else if (result.status === 'unsupported' && item.key !== 'connectivity') unsupported += 1
      else {
        failed += 1
        failureMessages.push(`${item.label}：${result.message}`)
      }

      updateBatchModel(row.id, { completed, passed, unsupported, failed })

      if (item.key === 'connectivity' && result.status !== 'passed') {
        updateBatchModel(row.id, {
          phase: 'done',
          currentCapability: undefined,
          summary: `连通性未通过，后续 3 项已跳过：${result.message}`,
        })
        return
      }
    }

    updateBatchModel(row.id, {
      phase: 'done',
      currentCapability: undefined,
      summary:
        failed > 0
          ? `失败原因：${failureMessages.slice(0, 2).join('；')}`
          : unsupported > 0
            ? `探测完成：${passed} 项通过，${unsupported} 项不支持`
            : '全部能力测试通过',
    })
  }

  const runAllModelTests = async () => {
    if (data.length === 0) {
      message.warning('当前没有可探测的模型')
      return
    }
    const models = [...data]
    const runId = ++batchRunRef.current
    setBatchStates(Object.fromEntries(models.map((row) => [
      row.id,
      {
        phase: 'pending',
        completed: 0,
        passed: 0,
        unsupported: 0,
        failed: 0,
      } satisfies BatchModelTestState,
    ])))
    setBatchOpen(true)
    setBatchRunning(true)

    // 两个 worker 并发：明显缩短总耗时，同时避免一次把同一厂商的配额打满。
    let cursor = 0
    const worker = async () => {
      while (batchRunRef.current === runId) {
        const index = cursor
        cursor += 1
        if (index >= models.length) return
        await probeOneModel(models[index], runId)
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(2, models.length) }, () => worker()),
    )
    if (batchRunRef.current !== runId) return
    await fetchData()
    if (batchRunRef.current !== runId) return
    setBatchRunning(false)
  }

  const closeBatchTest = () => {
    if (batchRunning) batchRunRef.current += 1
    setBatchRunning(false)
    setBatchOpen(false)
  }

  const completedTests = CAPABILITY_TESTS.filter((item) =>
    ['done', 'skipped'].includes(testStates[item.key].phase),
  ).length
  const passedTests = CAPABILITY_TESTS.filter(
    (item) => testStates[item.key].result?.status === 'passed',
  ).length
  const batchEntries = Object.entries(batchStates)
  const batchCompleted = batchEntries.filter(([, state]) => state.phase === 'done').length
  const batchClean = batchEntries.filter(
    ([, state]) => state.phase === 'done' && state.failed === 0,
  ).length
  const batchPercent = batchEntries.length > 0
    ? Math.round((batchCompleted / batchEntries.length) * 100)
    : 0

  const renderCapability = (
    status: AdminModel['vision_status'],
    supported: boolean,
    detail?: string,
  ) => {
    if (status === 'unknown') return <Tag>待探测</Tag>
    if (status === 'failed') return <Tag color="error">探测失败</Tag>
    if (!supported) return <Tag>不支持</Tag>
    return <Tag color="success">{detail || '支持'}</Tag>
  }

  const columns: ColumnsType<AdminModel> = [
    {
      title: '排序',
      width: 110,
      fixed: 'left',
      render: (_, row, index) => {
        const busy = reorderingId !== null
        const isFirst = index === 0
        const isLast = index === data.length - 1
        return (
          <Space size={0} className={styles.sortActions}>
            <Button
              type="text"
              size="small"
              title="上移"
              disabled={isFirst || busy}
              loading={reorderingId === row.id}
              icon={<ArrowUp size={14} />}
              onClick={() => handleReorder(row.id, 'up')}
            />
            <Button
              type="text"
              size="small"
              title="下移"
              disabled={isLast || busy}
              icon={<ArrowDown size={14} />}
              onClick={() => handleReorder(row.id, 'down')}
            />
            <Button
              type="text"
              size="small"
              title="置顶"
              disabled={isFirst || busy}
              icon={<ArrowUpToLine size={14} />}
              onClick={() => handleReorder(row.id, 'top')}
            />
          </Space>
        )
      },
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      width: 80,
      fixed: 'left',
      render: (v: boolean) => <Tag color={v ? 'green' : 'default'}>{v ? '启用' : '停用'}</Tag>,
    },
    {
      title: '厂商',
      dataIndex: 'provider',
      width: 190,
      fixed: 'left',
      render: (_: string, row) => {
        const provider = providerForModel(row)
        return (
          <span className={styles.providerCell}>
            <span className={styles.providerIcon}>
              <ModelIcon name={provider?.logo || logoForModel(row)} size={21} />
            </span>
            <span className={styles.providerMeta}>
              <strong>{provider?.label || row.provider || 'OpenAI'}</strong>
              <small>{provider?.description || 'OpenAI 兼容协议'}</small>
            </span>
          </span>
        )
      },
    },
    { title: '模型 ID', dataIndex: 'id', width: 220, ellipsis: true, fixed: 'left' },
    { title: 'Base URL', dataIndex: 'base_url', width: 220, ellipsis: true, render: (v: string | null) => v || '（官方）' },
    { title: 'API Key', dataIndex: 'api_key', width: 140, render: (v: string) => <span className={styles.secret}>{v || '—'}</span> },
    {
      title: '识图能力',
      dataIndex: 'vision',
      width: 105,
      render: (v: boolean, row) => renderCapability(row.vision_status, v),
    },
    {
      title: '思考能力',
      dataIndex: 'thinking',
      width: 145,
      render: (v: boolean, row) =>
        renderCapability(
          row.thinking_status,
          v,
          row.thinking_toggle ? '支持 · 可关闭' : '支持 · 不可关闭',
        ),
    },
    { title: '倍率', dataIndex: 'cost', width: 70 },
    {
      title: '操作',
      width: 250,
      fixed: 'right',
      render: (_, row) => (
        <Space size={4}>
          <Button type="link" size="small" onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Button type="link" size="small" onClick={() => openCopy(row)}>
            复制
          </Button>
          <Button
            type="link"
            size="small"
            loading={testsRunning && testTarget?.id === row.id}
            disabled={batchRunning}
            onClick={() => openFullTest(row)}
          >
            全面测试
          </Button>
          <Popconfirm title="确认删除该模型？" onConfirm={() => onDelete(row.id)} okText="删除" cancelText="取消">
            <Button type="link" size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <Space wrap>
          <Button type="primary" onClick={openCreate}>
            新建模型
          </Button>
          <Button onClick={handleExport}>导出</Button>
          <Button onClick={handleImportClick}>导入</Button>
          <Button
            icon={<Radar size={15} />}
            loading={batchRunning}
            disabled={testsRunning}
            onClick={() => void runAllModelTests()}
          >
            一键探测全部
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className={styles.fileInput}
            onChange={handleImportFile}
          />
        </Space>
        <Space>
          <Button disabled={selectedIds.length === 0} onClick={() => batchSetEnabled(true)}>
            启用所选
          </Button>
          <Button disabled={selectedIds.length === 0} onClick={() => batchSetEnabled(false)}>
            禁用所选
          </Button>
        </Space>
      </div>

      <Table
        rowKey="id"
        columns={columns}
        dataSource={data}
        loading={loading}
        scroll={{ x: 1420 }}
        rowSelection={{
          fixed: true,
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys as string[]),
        }}
        pagination={false}
      />

      <Modal
        title={null}
        open={batchOpen}
        onCancel={closeBatchTest}
        width={760}
        destroyOnHidden
        maskClosable={!batchRunning}
        className={`${styles.testModal} ${styles.batchModal}`}
        footer={
          <div className={styles.testFooter}>
            <span className={styles.testFootnote}>
              全部配置模型（含停用）都会探测；最多同时执行 2 个模型
            </span>
            <Space>
              <Button danger={batchRunning} onClick={closeBatchTest}>
                {batchRunning ? '停止探测' : '关闭'}
              </Button>
              {!batchRunning && (
                <Button
                  type="primary"
                  icon={<RotateCw size={15} />}
                  onClick={() => void runAllModelTests()}
                >
                  重新探测全部
                </Button>
              )}
            </Space>
          </div>
        }
      >
        <div className={styles.batchPanel}>
          <div className={styles.batchHeader}>
            <div className={styles.batchRadar}>
              <Radar size={26} />
              {batchRunning && <span aria-hidden />}
            </div>
            <div className={styles.testHeading}>
              <span className={styles.testEyebrow}>MODEL FLEET DIAGNOSTICS</span>
              <h2>全部模型能力探测</h2>
              <p>连通性优先；失败后自动跳过该模型的后续项目。</p>
            </div>
            <div className={styles.testScore}>
              <strong>{batchCompleted}</strong>
              <span>/ {data.length} 完成</span>
            </div>
          </div>

          <Progress
            percent={batchPercent}
            showInfo={false}
            strokeColor="#1677ff"
            trailColor="rgba(22, 119, 255, 0.10)"
            className={styles.testProgress}
          />

          <div className={styles.batchSummary}>
            <span>{batchRunning ? '正在探测' : '探测结束'}</span>
            <strong>{batchClean} 个模型无失败项</strong>
          </div>

          <div className={styles.batchList}>
            {data.map((row) => {
              const state = batchStates[row.id] ?? {
                phase: 'pending',
                completed: 0,
                passed: 0,
                unsupported: 0,
                failed: 0,
              }
              const currentLabel = CAPABILITY_TESTS.find(
                (item) => item.key === state.currentCapability,
              )?.label
              const stateIcon =
                state.phase === 'running' ? (
                  <Spin size="small" />
                ) : state.phase === 'done' && state.failed > 0 ? (
                  <CircleX size={20} />
                ) : state.phase === 'done' && state.unsupported > 0 ? (
                  <CircleHelp size={20} />
                ) : state.phase === 'done' ? (
                  <CircleCheck size={20} />
                ) : (
                  <span className={styles.pendingDot} />
                )
              return (
                <div
                  key={row.id}
                  className={`${styles.batchItem} ${state.phase === 'running' ? styles.batchRunning : ''} ${state.phase === 'done' && state.failed > 0 ? styles.failed : ''}`}
                >
                  <div className={styles.batchModelIcon}>
                    <ModelIcon name={logoForModel(row)} size={22} />
                  </div>
                  <div className={styles.batchModelBody}>
                    <div className={styles.batchModelTitle}>
                      <strong>{row.id}</strong>
                      <span>{providerForModel(row)?.label || row.provider}</span>
                    </div>
                    <p title={state.phase === 'done' ? state.summary : undefined}>
                      {state.phase === 'running'
                        ? `正在测试${currentLabel || '模型能力'}…`
                        : state.phase === 'done'
                          ? state.summary
                          : '等待探测'}
                    </p>
                  </div>
                  <div className={styles.batchMetrics}>
                    <span>{state.passed} 通过</span>
                    {state.unsupported > 0 && <span>{state.unsupported} 不支持</span>}
                    {state.failed > 0 && <span data-failed>{state.failed} 失败</span>}
                  </div>
                  <div className={styles.batchStateIcon}>{stateIcon}</div>
                </div>
              )
            })}
          </div>
        </div>
      </Modal>

      <Drawer
        title={editing ? `编辑模型 · ${editing.id}` : isCopy ? '复制模型' : '新建模型'}
        open={open}
        onClose={closeDrawer}
        width={480}
        destroyOnHidden
        footer={
          <Space className={styles.drawerFooter}>
            <Button onClick={closeDrawer}>取消</Button>
            <Button type="primary" onClick={submit}>
              保存
            </Button>
          </Space>
        }
      >
        <Form form={form} layout="vertical">
          <Form.Item
            label="模型厂商"
            name="provider"
            rules={[{ required: true, message: '请选择模型实际使用的 API 厂商' }]}
            extra="厂商决定请求协议、能力参数与 Logo；OpenAI 兼容中转请选择 OpenAI 并填写 Base URL。"
          >
            <Select
              showSearch
              loading={loading && providers.length === 0}
              placeholder="选择模型厂商"
              optionFilterProp="label"
              onChange={handleProviderChange}
              options={providers.map((provider) => ({
                value: provider.id,
                label: provider.label,
                description: provider.description,
                logo: provider.logo,
              }))}
              optionRender={(option) => (
                <span className={styles.providerOption}>
                  <span className={styles.providerOptionIcon}>
                    <ModelIcon name={String(option.data.logo)} size={20} />
                  </span>
                  <span>
                    <strong>{option.label}</strong>
                    <small>{String(option.data.description)}</small>
                  </span>
                </span>
              )}
              labelRender={(props) => {
                const provider = providerById.get(String(props.value))
                return provider ? (
                  <span className={styles.providerSelection}>
                    <ModelIcon name={provider.logo} size={18} />
                    {provider.label}
                  </span>
                ) : (
                  <>{props.label}</>
                )
              }}
            />
          </Form.Item>
          <Form.Item
            label="模型 ID"
            name="id"
            rules={[{ required: true, message: '请填写模型 ID（主键）' }]}
          >
            {/* 编辑时主键不可改 */}
            <Input disabled={!!editing} placeholder="如 qwen3-coder-next" />
          </Form.Item>
          <Form.Item
            label="Base URL（空=官方）"
            name="base_url"
            extra={
              selectedProvider?.default_base_url
                ? `推荐端点：${selectedProvider.default_base_url}。切换厂商会保留当前填写的地址。`
                : selectedProvider?.id === 'openai'
                  ? '留空使用 OpenAI 官方端点；中转站或自部署服务可填写兼容地址。'
                  : '留空时使用该厂商 SDK 的官方端点。'
            }
          >
            <Input placeholder={selectedProvider?.default_base_url || '留空使用官方端点'} />
          </Form.Item>
          <Form.Item
            label="API Key"
            name="api_key"
            rules={[
              {
                required: !editing,
                message: '请填写 API Key',
              },
            ]}
            extra={
              editing
                ? '留空表示不修改；切换厂商也会保留已保存的 Key'
                : isCopy
                  ? '复制不会带入原 Key，请重新填写'
                  : '新建模型需要填写对应厂商的 API Key'
            }
          >
            <Input.Password placeholder="API Key" />
          </Form.Item>
          <Space size="large">
            <Form.Item label="倍率" name="cost">
              <InputNumber min={1} />
            </Form.Item>
            <Form.Item label="启用" name="enabled" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
          <div className={styles.capabilityNotice}>
            识图与思考能力由“全面测试”自动探测并记录，不能手动修改。
            厂商、Base URL 或 API Key 变化后会恢复为“待探测”。
          </div>
        </Form>
      </Drawer>


      <Modal
        title={null}
        open={!!testTarget}
        onCancel={closeFullTest}
        width={680}
        destroyOnHidden
        className={styles.testModal}
        footer={
          <div className={styles.testFooter}>
            <span className={styles.testFootnote}>识图与思考探测结果会自动写入模型能力标记</span>
            <Space>
              <Button onClick={closeFullTest}>关闭</Button>
              <Button
                type="primary"
                icon={<RotateCw size={15} />}
                loading={testsRunning}
                onClick={() => testTarget && void runAllTests(testTarget)}
              >
                重新测试全部
              </Button>
            </Space>
          </div>
        }
      >
        {testTarget && (
          <div className={styles.testPanel}>
            <div className={styles.testHeader}>
              <div className={styles.testModelIcon}>
                <ModelIcon name={logoForModel(testTarget)} size={30} />
              </div>
              <div className={styles.testHeading}>
                <span className={styles.testEyebrow}>MODEL CAPABILITY CHECK</span>
                <h2>{testTarget.id}</h2>
                <p>正在以真实请求验证模型能力，测试项将依次完成。</p>
              </div>
              <div className={styles.testScore}>
                <strong>{passedTests}</strong>
                <span>/ {CAPABILITY_TESTS.length} 通过</span>
              </div>
            </div>

            <Progress
              percent={Math.round((completedTests / CAPABILITY_TESTS.length) * 100)}
              showInfo={false}
              strokeColor="#1677ff"
              trailColor="rgba(22, 119, 255, 0.10)"
              className={styles.testProgress}
            />

            <div className={styles.testList}>
              {CAPABILITY_TESTS.map((item) => {
                const state = testStates[item.key]
                const result = state.result
                const Icon = item.icon
                const statusIcon =
                  state.phase === 'running' ? (
                    <Spin size="small" />
                  ) : state.phase === 'skipped' ? (
                    <CircleMinus size={20} />
                  ) : result?.status === 'passed' ? (
                    <CircleCheck size={20} />
                  ) : result?.status === 'unsupported' ? (
                    <CircleHelp size={20} />
                  ) : result?.status === 'failed' ? (
                    <CircleX size={20} />
                  ) : (
                    <span className={styles.pendingDot} />
                  )
                return (
                  <div
                    key={item.key}
                    className={`${styles.testItem} ${result ? styles[result.status] : ''} ${state.phase === 'skipped' ? styles.skipped : ''}`}
                  >
                    <div className={styles.testItemIcon}><Icon size={19} /></div>
                    <div className={styles.testItemBody}>
                      <div className={styles.testItemTitle}>
                        <strong>{item.label}</strong>
                        {result?.latency_ms != null && <span>{result.latency_ms} ms</span>}
                      </div>
                      {result ? (
                        <>
                          <p className={styles.testResultMessage}>
                            {result.status === 'failed' ? '失败原因：' : ''}
                            {result.message}
                          </p>
                          {!!result.details?.length && (
                            <div className={styles.testDetails}>
                              {result.details.map((detail) => (
                                <div key={detail.key} className={styles.testDetail}>
                                  <span data-status={detail.status}>
                                    {detail.status === 'passed' ? (
                                      <CircleCheck size={13} />
                                    ) : detail.status === 'unsupported' ? (
                                      <CircleHelp size={13} />
                                    ) : (
                                      <CircleX size={13} />
                                    )}
                                    {detail.label}
                                  </span>
                                  <em>{detail.message}</em>
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      ) : (
                        <p>
                          {state.phase === 'running'
                            ? '正在发送探测请求…'
                            : state.phase === 'skipped'
                              ? state.message
                              : item.description}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      className={styles.testStatus}
                      disabled={testsRunning || state.phase === 'skipped'}
                      title={
                        state.phase === 'done'
                          ? `重新测试${item.label}`
                          : state.phase === 'skipped'
                            ? state.message
                            : item.description
                      }
                      onClick={() => state.phase === 'done' && void retryCapability(item.key)}
                    >
                      {statusIcon}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
