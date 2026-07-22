import { useCallback, useEffect, useRef, useState } from 'react'
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
  type ModelTestCapability,
} from '@/lib/api'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpToLine,
  BrainCircuit,
  CircleCheck,
  CircleHelp,
  CircleX,
  ImageIcon,
  RotateCw,
  Wrench,
  Wifi,
  type LucideIcon,
} from 'lucide-react'
import { ModelIcon } from '@/lib/lobeIcon'
import styles from './index.module.scss'

// 品牌 Logo 选项：value 为 @lobehub/icons 组件标识符，label 用中文名方便识别。
// 与 server/app/setup.py 的 ICON_SUGGESTIONS 对应，新增品牌时两边同步维护即可。
const LOGO_OPTIONS = [
  { value: 'OpenAI', label: 'OpenAI' },
  { value: 'Qwen.Color', label: '通义千问' },
  { value: 'Claude.Color', label: 'Claude（Anthropic）' },
  { value: 'Gemini.Color', label: 'Gemini（谷歌）' },
  { value: 'DeepSeek.Color', label: 'DeepSeek 深度求索' },
  { value: 'Moonshot', label: '月之暗面 Kimi' },
  { value: 'Doubao.Color', label: '豆包' },
  { value: 'Grok', label: 'Grok（xAI）' },
  { value: 'Zhipu.Color', label: '智谱 GLM' },
  { value: 'MiniMax.Color', label: 'MiniMax' },
]

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
  phase: 'pending' | 'running' | 'done'
  result?: ModelCapabilityTestResult
}

function emptyTestStates(): Record<ModelTestCapability, TestItemState> {
  return Object.fromEntries(
    CAPABILITY_TESTS.map((item) => [item.key, { phase: 'pending' }]),
  ) as Record<ModelTestCapability, TestItemState>
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

// ============================================
// LLM 模型管理页（对齐 admin.py 的 LlmModelAdmin：增删改 + 启停批量）
// ============================================
export default function Models() {
  const { message, modal } = AntdApp.useApp()
  const [data, setData] = useState<AdminModel[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [reorderingId, setReorderingId] = useState<string | null>(null)
  const [testTarget, setTestTarget] = useState<AdminModel | null>(null)
  const [testStates, setTestStates] = useState(emptyTestStates)
  const [testsRunning, setTestsRunning] = useState(false)
  const testRunRef = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  /** 新建/复制时追加到列表末尾的排序权重 */
  const nextSortOrder = () =>
    data.reduce((max, m) => Math.max(max, m.sort_order), -1) + 1

  // 新建 / 编辑抽屉；editing=null 且 open=true 表示新建或复制
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<AdminModel | null>(null)
  const [isCopy, setIsCopy] = useState(false)
  const [form] = Form.useForm()

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
      setData(await listModels())
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
    form.setFieldsValue({ vision: false, enabled: true, cost: 1 })
    setOpen(true)
  }

  const openEdit = (model: AdminModel) => {
    setEditing(model)
    setIsCopy(false)
    form.setFieldsValue({
      id: model.id,
      base_url: model.base_url,
      api_key: '', // 敏感值不回填脱敏串；留空表示不改
      logo: model.logo,
      vision: model.vision,
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
      base_url: model.base_url,
      api_key: '', // 列表里是脱敏值，复制后需重新填写
      logo: model.logo,
      vision: model.vision,
      cost: model.cost,
      enabled: model.enabled,
    })
    setOpen(true)
  }

  const closeDrawer = () => {
    setOpen(false)
    setIsCopy(false)
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
  ) => {
    setTestStates((prev) => ({ ...prev, [capability]: { phase: 'running' } }))
    try {
      const result = await testModelCapability(row.id, capability)
      if (testRunRef.current !== runId) return
      setTestStates((prev) => ({ ...prev, [capability]: { phase: 'done', result } }))
    } catch (error) {
      if (testRunRef.current !== runId) return
      const rawReason = error instanceof Error ? error.message : '未知错误'
      const timeoutMatch = rawReason.match(/timeout of (\d+)ms exceeded/i)
      const reason = timeoutMatch
        ? `等待模型响应超时（${Math.round(Number(timeoutMatch[1]) / 1000)} 秒），请稍后单独重试`
        : rawReason
      setTestStates((prev) => ({
        ...prev,
        [capability]: {
          phase: 'done',
          result: { capability, status: 'failed', message: reason, latency_ms: null, details: [] },
        },
      }))
    }
  }

  const runAllTests = async (row: AdminModel) => {
    const runId = ++testRunRef.current
    setTestStates(emptyTestStates())
    setTestsRunning(true)
    for (const item of CAPABILITY_TESTS) {
      if (testRunRef.current !== runId) return
      await runCapability(row, item.key, runId)
    }
    if (testRunRef.current === runId) setTestsRunning(false)
  }

  const openFullTest = (row: AdminModel) => {
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
    if (testRunRef.current === runId) setTestsRunning(false)
  }

  const completedTests = CAPABILITY_TESTS.filter((item) => testStates[item.key].phase === 'done').length
  const passedTests = CAPABILITY_TESTS.filter(
    (item) => testStates[item.key].result?.status === 'passed',
  ).length

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
      title: 'Logo',
      dataIndex: 'logo',
      width: 70,
      align: 'center',
      fixed: 'left',
      render: (v: string) =>
        v ? (
          <ModelIcon
            name={v}
            size={22}
            fallback={<span className={styles.secret}>{v}</span>}
          />
        ) : (
          '—'
        ),
    },
    { title: '模型 ID', dataIndex: 'id', width: 220, ellipsis: true, fixed: 'left' },
    { title: 'Base URL', dataIndex: 'base_url', width: 220, ellipsis: true, render: (v: string | null) => v || '（官方）' },
    { title: 'API Key', dataIndex: 'api_key', width: 140, render: (v: string) => <span className={styles.secret}>{v || '—'}</span> },
    { title: '识图', dataIndex: 'vision', width: 70, render: (v: boolean) => (v ? '✓' : '—') },
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
        scroll={{ x: 1120 }}
        rowSelection={{
          fixed: true,
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys as string[]),
        }}
        pagination={false}
      />

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
          <Form.Item label="模型 ID" name="id" rules={[{ required: true, message: '请填写模型 ID（主键）' }]}>
            {/* 编辑时主键不可改 */}
            <Input disabled={!!editing} placeholder="如 qwen3-coder-next" />
          </Form.Item>
          <Form.Item label="Base URL（空=官方）" name="base_url">
            <Input placeholder="OpenAI 兼容端点，留空用官方" />
          </Form.Item>
          <Form.Item
            label="API Key"
            name="api_key"
            extra={
              editing
                ? '留空表示不修改（列表中已脱敏显示）'
                : isCopy
                  ? '复制不会带入原 Key，请重新填写'
                  : undefined
            }
          >
            <Input.Password placeholder="API Key" />
          </Form.Item>
          <Form.Item label="品牌 Logo" name="logo" extra="选择模型所属品牌，列表用于展示对应图标">
            <Select
              allowClear
              showSearch
              placeholder="选择品牌 Logo"
              options={LOGO_OPTIONS}
              optionFilterProp="label"
              // 下拉项：图标 + 中文名
              optionRender={(opt) => (
                <span className={styles.logoOption}>
                  <ModelIcon name={String(opt.value)} size={18} />
                  {opt.label}
                </span>
              )}
              // 选中后的回显：同样带图标
              labelRender={(props) =>
                props.value ? (
                  <span className={styles.logoOption}>
                    <ModelIcon name={String(props.value)} size={18} />
                    {props.label}
                  </span>
                ) : (
                  <>{props.label}</>
                )
              }
            />
          </Form.Item>
          <Space size="large">
            <Form.Item label="倍率" name="cost">
              <InputNumber min={1} />
            </Form.Item>
            <Form.Item label="识图" name="vision" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item label="启用" name="enabled" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
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
            <span className={styles.testFootnote}>测试只发送探测请求，不会修改模型配置</span>
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
                <ModelIcon name={testTarget.logo} size={30} />
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
                    className={`${styles.testItem} ${result ? styles[result.status] : ''}`}
                  >
                    <div className={styles.testItemIcon}><Icon size={19} /></div>
                    <div className={styles.testItemBody}>
                      <div className={styles.testItemTitle}>
                        <strong>{item.label}</strong>
                        {result?.latency_ms != null && <span>{result.latency_ms} ms</span>}
                      </div>
                      {result?.details?.length ? (
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
                              <em title={detail.message}>{detail.message}</em>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p title={result?.message}>
                          {result
                            ? `${result.status === 'failed' ? '失败原因：' : ''}${result.message}`
                            : state.phase === 'running'
                              ? '正在发送探测请求…'
                              : item.description}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      className={styles.testStatus}
                      disabled={testsRunning}
                      title={state.phase === 'done' ? `重新测试${item.label}` : item.description}
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
