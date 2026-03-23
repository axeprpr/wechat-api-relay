import React from 'react'
import ReactDOM from 'react-dom/client'
import Editor from '@monaco-editor/react'
import {
  Bot,
  CheckCircle2,
  CircleHelp,
  CirclePlay,
  CircleStop,
  DatabaseZap,
  MessageSquareCode,
  Plus,
  QrCode,
  Save,
  Settings2,
  Trash2,
  X,
} from 'lucide-react'
import './styles.css'

type WeixinSettings = {
  base_url: string
  bot_type: string
  route_tag: string
  poll_timeout: number
  user_agent: string
}

type MatchConfig = { mode: string; pattern: string }
type TargetConfig = {
  method: string
  url_template: string
  headers: Record<string, string>
  query: Record<string, string>
  body_template: string
  timeout_ms: number
  insecure_skip_tls: boolean
}
type ResponseConfig = { template: string }
type ConversationConfig = { save_history: boolean; history_limit: number }

type Rule = {
  id: string
  name: string
  description: string
  enabled: boolean
  match: MatchConfig
  target: TargetConfig
  response: ResponseConfig
  conversation: ConversationConfig
}

type Settings = {
  weixin: WeixinSettings
  active_account_id: string
  rules: Rule[]
  account_rules: Record<string, string[]>
}

type Account = {
  id: string
  raw_id: string
  user_id: string
  saved_at: string
}

type RuntimeState = {
  running: boolean
  account_id: string
  running_account_ids: string[]
}

type PreviewResult = {
  request_method: string
  request_url: string
  request_headers: Record<string, string>
  request_body: string
  status_code: number
  response_body: string
  reply: string
  duration_ms: number
}

type AppState = {
  settings: Settings
  accounts: Account[]
  runtime: RuntimeState
}

type RuleDraft = Rule

type WeixinConfigDraft = {
  base_url: string
  bot_type: string
  route_tag: string
  rule_ids: string[]
}

type JsonDrafts = {
  headers: string
  query: string
}

type ViewKey = 'rules' | 'weixin'
type RuleStep = 1 | 2 | 3
type ConfigStep = 1 | 2 | 3
type RuleEditorTab = 'headers' | 'query' | 'body' | 'response'

const emptyRule = (): Rule => ({
  id: `rule-${Math.random().toString(36).slice(2, 8)}`,
  name: 'New Rule',
  description: '',
  enabled: true,
  match: { mode: 'all', pattern: '' },
  target: {
    method: 'POST',
    url_template: '',
    headers: { 'Content-Type': 'application/json' },
    query: {},
    body_template: '{\n  "text": "{{ .Message.text }}",\n  "from": "{{ .Message.from }}"\n}',
    timeout_ms: 60000,
    insecure_skip_tls: false,
  },
  response: { template: '{{ .Response.body }}' },
  conversation: { save_history: false, history_limit: 12 },
})

function App() {
  const [state, setState] = React.useState<AppState | null>(null)
  const [currentView, setCurrentView] = React.useState<ViewKey>('rules')
  const [statusMessage, setStatusMessage] = React.useState('Ready')
  const [statusKind, setStatusKind] = React.useState<'info' | 'success' | 'error'>('info')

  const [ruleSearch, setRuleSearch] = React.useState('')
  const [ruleModalOpen, setRuleModalOpen] = React.useState(false)
  const [ruleStep, setRuleStep] = React.useState<RuleStep>(1)
  const [ruleEditorTab, setRuleEditorTab] = React.useState<RuleEditorTab>('headers')
  const [ruleDraft, setRuleDraft] = React.useState<RuleDraft>(emptyRule())
  const [ruleJsonDrafts, setRuleJsonDrafts] = React.useState<JsonDrafts>({ headers: '{}', query: '{}' })
  const [rulePreviewAccountId, setRulePreviewAccountId] = React.useState('')
  const [rulePreviewUserId, setRulePreviewUserId] = React.useState('debug-user@im.wechat')
  const [rulePreviewText, setRulePreviewText] = React.useState('你好')
  const [previewLoading, setPreviewLoading] = React.useState(false)
  const [previewResult, setPreviewResult] = React.useState<PreviewResult | null>(null)
  const [previewError, setPreviewError] = React.useState('')

  const [configModalOpen, setConfigModalOpen] = React.useState(false)
  const [configStep, setConfigStep] = React.useState<ConfigStep>(1)
  const [configDraft, setConfigDraft] = React.useState<WeixinConfigDraft>({
    base_url: '',
    bot_type: '',
    route_tag: '',
    rule_ids: [],
  })
  const [editingAccountId, setEditingAccountId] = React.useState('')
  const [loginSession, setLoginSession] = React.useState('')
  const [qrURL, setQrURL] = React.useState('')
  const [pendingRuleIDs, setPendingRuleIDs] = React.useState<string[]>([])

  const loadState = React.useCallback(async () => {
    const data = (await apiJSON<AppState>('/api/state')) as AppState
    setState(data)
    setRulePreviewAccountId((current) => current || data.settings.active_account_id || data.accounts[0]?.id || '')
  }, [])

  React.useEffect(() => {
    void loadState()
  }, [loadState])

  const bindRulesAfterLogin = React.useCallback(
    async (accountID: string, ruleIDs: string[]) => {
      const settings = await apiJSON<Settings>('/api/settings')
      const next: Settings = {
        ...settings,
        active_account_id: accountID,
        account_rules: {
          ...settings.account_rules,
          [accountID]: ruleIDs,
        },
      }
      const saved = await apiJSON<Settings>('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      })
      setState((current) => (current ? { ...current, settings: saved } : current))
    },
    []
  )

  React.useEffect(() => {
    if (!loginSession) return
    const timer = window.setInterval(async () => {
      try {
        const data = await apiJSON<{ status: string; account_id?: string }>(`/api/login/status?session_key=${encodeURIComponent(loginSession)}`)
        setStatusKind('info')
        setStatusMessage(`登录状态：${data.status}`)
        if (data.status === 'confirmed') {
          window.clearInterval(timer)
          setLoginSession('')
          setQrURL('')
          if (data.account_id && pendingRuleIDs.length > 0) {
            await bindRulesAfterLogin(data.account_id, pendingRuleIDs)
            setPendingRuleIDs([])
          }
          await loadState()
          setStatusKind('success')
          setStatusMessage('微信配置创建成功')
        }
      } catch (error) {
        window.clearInterval(timer)
        setStatusKind('error')
        setStatusMessage(getErrorMessage(error))
      }
    }, 2500)
    return () => window.clearInterval(timer)
  }, [bindRulesAfterLogin, loadState, loginSession, pendingRuleIDs])

  if (!state) return <div className='loading'>Loading…</div>

  const filteredRules = state.settings.rules.filter((rule) => {
    const term = ruleSearch.trim().toLowerCase()
    if (!term) return true
    return [rule.name, rule.id, rule.description, rule.match.pattern, rule.target.url_template]
      .join(' ')
      .toLowerCase()
      .includes(term)
  })

  const persistSettings = async (nextSettings: Settings) => {
    const data = await apiJSON<Settings>('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nextSettings),
    })
    setState((current) => (current ? { ...current, settings: data } : current))
    return data
  }

  const openCreateRule = () => {
    const next = emptyRule()
    setRuleDraft(next)
    setRuleJsonDrafts({
      headers: JSON.stringify(next.target.headers, null, 2),
      query: JSON.stringify(next.target.query, null, 2),
    })
    setRulePreviewText('你好')
    setPreviewResult(null)
    setPreviewError('')
    setRuleStep(1)
    setRuleEditorTab('headers')
    setRuleModalOpen(true)
  }

  const openEditRule = (rule: Rule) => {
    setRuleDraft(structuredClone(rule))
    setRuleJsonDrafts({
      headers: JSON.stringify(rule.target.headers ?? {}, null, 2),
      query: JSON.stringify(rule.target.query ?? {}, null, 2),
    })
    setPreviewResult(null)
    setPreviewError('')
    setRuleStep(1)
    setRuleEditorTab('headers')
    setRuleModalOpen(true)
  }

  const saveRule = async () => {
    try {
      const headers = JSON.parse(ruleJsonDrafts.headers) as Record<string, string>
      const query = JSON.parse(ruleJsonDrafts.query) as Record<string, string>
      const nextRule = { ...ruleDraft, target: { ...ruleDraft.target, headers, query } }
      const exists = state.settings.rules.some((rule) => rule.id === nextRule.id)
      const rules = exists
        ? state.settings.rules.map((rule) => (rule.id === nextRule.id ? nextRule : rule))
        : [...state.settings.rules, nextRule]
      await persistSettings({ ...state.settings, rules })
      setRuleModalOpen(false)
      setStatusKind('success')
      setStatusMessage(exists ? '规则已更新' : '规则已创建')
    } catch (error) {
      setStatusKind('error')
      setStatusMessage(getErrorMessage(error, 'Headers 或 Query 不是合法 JSON'))
    }
  }

  const deleteRule = async (ruleID: string) => {
    const rules = state.settings.rules.filter((rule) => rule.id !== ruleID)
    const accountRules = Object.fromEntries(
      Object.entries(state.settings.account_rules).map(([accountID, ruleIDs]) => [
        accountID,
        ruleIDs.filter((id) => id !== ruleID),
      ])
    )
    await persistSettings({ ...state.settings, rules, account_rules: accountRules })
    setStatusKind('success')
    setStatusMessage('规则已删除')
  }

  const runPreview = async () => {
    setPreviewLoading(true)
    setPreviewResult(null)
    setPreviewError('')
    try {
      const headers = JSON.parse(ruleJsonDrafts.headers) as Record<string, string>
      const query = JSON.parse(ruleJsonDrafts.query) as Record<string, string>
      const data = await apiJSON<{ result?: PreviewResult; error?: string }>('/api/rules/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rule: { ...ruleDraft, target: { ...ruleDraft.target, headers, query } },
          account_id: rulePreviewAccountId,
          user_id: rulePreviewUserId,
          text: rulePreviewText,
        }),
      })
      setPreviewResult((data.result as PreviewResult) ?? null)
      setPreviewError((data.error as string) ?? '')
      setStatusKind(data.error ? 'error' : 'success')
      setStatusMessage(data.error || '规则调试完成')
    } catch (error) {
      setStatusKind('error')
      setStatusMessage(getErrorMessage(error))
      setPreviewError(getErrorMessage(error))
    } finally {
      setPreviewLoading(false)
    }
  }

  const openCreateConfig = () => {
    setEditingAccountId('')
    setConfigDraft({
      base_url: state.settings.weixin.base_url,
      bot_type: state.settings.weixin.bot_type,
      route_tag: state.settings.weixin.route_tag,
      rule_ids: [],
    })
    setConfigStep(1)
    setQrURL('')
    setLoginSession('')
    setConfigModalOpen(true)
  }

  const openEditConfig = (account: Account) => {
    setEditingAccountId(account.id)
    setConfigDraft({
      base_url: account.raw_id ? state.settings.weixin.base_url : state.settings.weixin.base_url,
      bot_type: state.settings.weixin.bot_type,
      route_tag: state.settings.weixin.route_tag,
      rule_ids: state.settings.account_rules[account.id] ?? [],
    })
    setConfigStep(1)
    setQrURL('')
    setLoginSession('')
    setConfigModalOpen(true)
  }

  const saveConfigBindings = async () => {
    if (!editingAccountId) return
    const nextSettings: Settings = {
      ...state.settings,
      account_rules: {
        ...state.settings.account_rules,
        [editingAccountId]: configDraft.rule_ids,
      },
    }
    await persistSettings(nextSettings)
    setConfigModalOpen(false)
    setStatusKind('success')
    setStatusMessage('微信配置已更新')
  }

  const startConfigLogin = async () => {
    try {
      const nextSettings: Settings = {
        ...state.settings,
        weixin: {
          ...state.settings.weixin,
          base_url: configDraft.base_url,
          bot_type: configDraft.bot_type,
          route_tag: configDraft.route_tag,
        },
      }
      await persistSettings(nextSettings)
      setPendingRuleIDs(configDraft.rule_ids)
      const data = await apiJSON<{ qr_code_url: string; session_key: string }>('/api/login/start', { method: 'POST' })
      setQrURL(`/api/login/qr?content=${encodeURIComponent(data.qr_code_url)}`)
      setLoginSession(data.session_key)
      setConfigStep(3)
      setStatusKind('info')
      setStatusMessage('请扫码完成微信配置绑定')
    } catch (error) {
      setStatusKind('error')
      setStatusMessage(getErrorMessage(error))
    }
  }

  const setAccountOnline = async (accountID: string) => {
    try {
      const nextSettings = { ...state.settings, active_account_id: accountID }
      await persistSettings(nextSettings)
      await apiJSON(`/api/runtime/start?account_id=${encodeURIComponent(accountID)}`, { method: 'POST' })
      await loadState()
      setStatusKind('success')
      setStatusMessage('微信配置已上线')
    } catch (error) {
      setStatusKind('error')
      setStatusMessage(getErrorMessage(error))
    }
  }

  const setAccountOffline = async (accountID: string) => {
    try {
      await apiJSON(`/api/runtime/stop?account_id=${encodeURIComponent(accountID)}`, { method: 'POST' })
      await loadState()
      setStatusKind('success')
      setStatusMessage('微信配置已下线')
    } catch (error) {
      setStatusKind('error')
      setStatusMessage(getErrorMessage(error))
    }
  }

  const toggleConfigRule = (ruleID: string, checked: boolean) => {
    const current = configDraft.rule_ids
    const next = checked ? Array.from(new Set([...current, ruleID])) : current.filter((id) => id !== ruleID)
    setConfigDraft((draft) => ({ ...draft, rule_ids: next }))
  }

  return (
    <div className='workspace compact-shell'>
      <aside className='sidebar'>
        <div className='sidebar-brand'>
          <div className='sidebar-logo'>
            <Bot size={18} />
          </div>
          <div>
            <div className='sidebar-title'>wechat-api-relay</div>
            <div className='sidebar-subtitle'>OpenClaw WeChat Hook</div>
          </div>
        </div>

        <nav className='sidebar-nav'>
          <button className={`sidebar-nav-item ${currentView === 'rules' ? 'active' : ''}`} onClick={() => setCurrentView('rules')}>
            <DatabaseZap size={16} />
            API 规则
          </button>
          <button className={`sidebar-nav-item ${currentView === 'weixin' ? 'active' : ''}`} onClick={() => setCurrentView('weixin')}>
            <Settings2 size={16} />
            微信配置
          </button>
        </nav>
      </aside>

      <main className='main clean-main'>
        {statusMessage && statusMessage !== 'Ready' ? <div className={`page-status ${statusKind}`}>{statusMessage}</div> : null}
        {currentView === 'rules' ? (
          <section className='list-page'>
            <div className='list-toolbar'>
              <input
                className='toolbar-search'
                placeholder='搜索规则名称、ID、匹配词或 URL'
                value={ruleSearch}
                onChange={(e) => setRuleSearch(e.target.value)}
              />
              <button className='button primary' onClick={openCreateRule}>
                <Plus size={16} />
                新建规则
              </button>
            </div>

            <div className='list-table'>
              <div className='list-head rule-grid'>
                <span>规则名称</span>
                <span>匹配方式</span>
                <span>目标接口</span>
                <span>状态</span>
                <span>操作</span>
              </div>
              {filteredRules.map((rule) => (
                <div key={rule.id} className='list-row rule-grid'>
                  <div className='title-col'>
                    <strong>{rule.name}</strong>
                    <span>{rule.id}</span>
                  </div>
                  <span>{rule.match.mode} / {rule.match.pattern || '*'}</span>
                  <span className='truncate-cell'>{rule.target.method} {rule.target.url_template || '(未填写)'}</span>
                  <StatusBadge live={rule.enabled}>{rule.enabled ? '启用' : '停用'}</StatusBadge>
                  <div className='row-actions'>
                    <button className='button secondary' onClick={() => openEditRule(rule)}>编辑</button>
                    <button className='button ghost-danger' onClick={() => void deleteRule(rule.id)}>删除</button>
                  </div>
                </div>
              ))}
              {filteredRules.length === 0 ? <div className='empty-state'>还没有规则。先点右上角“新建规则”。</div> : null}
            </div>
          </section>
        ) : (
          <section className='list-page'>
            <div className='list-toolbar'>
              <div className='toolbar-note'>这里的“微信配置”实际对应一个已经扫码绑定完成的微信账号。</div>
              <button className='button primary' onClick={openCreateConfig}>
                <Plus size={16} />
                新建配置
              </button>
            </div>

            <div className='list-table'>
              <div className='list-head config-grid'>
                <span>微信账号</span>
                <span>绑定规则</span>
                <span>状态</span>
                <span>操作</span>
              </div>
              {state.accounts.map((account) => {
                const isOnline = (state.runtime.running_account_ids ?? []).includes(account.id)
                const boundRules = state.settings.account_rules[account.id] ?? []
                return (
                  <div key={account.id} className='list-row config-grid'>
                    <div className='title-col'>
                      <strong>{account.user_id}</strong>
                      <span>{account.id}</span>
                    </div>
                    <span>{boundRules.length} 条规则</span>
                    <StatusBadge live={isOnline}>{isOnline ? '在线' : '离线'}</StatusBadge>
                    <div className='row-actions'>
                      <button className='button secondary' onClick={() => openEditConfig(account)}>编辑</button>
                      {isOnline ? (
                        <button className='button ghost-danger' onClick={() => void setAccountOffline(account.id)}>下线</button>
                      ) : (
                        <button className='button primary' onClick={() => void setAccountOnline(account.id)}>上线</button>
                      )}
                    </div>
                  </div>
                )
              })}
              {state.accounts.length === 0 ? <div className='empty-state'>还没有微信配置。先点右上角“新建配置”并扫码绑定。</div> : null}
            </div>
          </section>
        )}
      </main>

      {ruleModalOpen ? (
        <Modal title={ruleDraft.id && state.settings.rules.some((rule) => rule.id === ruleDraft.id) ? '编辑规则' : '新建规则'} onClose={() => setRuleModalOpen(false)}>
          <StepTabs
            steps={[
              { id: 1, label: '基本信息' },
              { id: 2, label: '请求配置' },
              { id: 3, label: '回复与调试' },
            ]}
            current={ruleStep}
            onChange={(step) => setRuleStep(step as RuleStep)}
          />

          {ruleStep === 1 ? (
            <div className='modal-section'>
              <div className='form-grid'>
                <Field label={<LabelWithHint label='Rule ID' hint='规则的稳定标识。示例：`order-query`。已经绑定到账号后不要频繁改。' />}>
                  <input value={ruleDraft.id} onChange={(e) => setRuleDraft((draft) => ({ ...draft, id: e.target.value }))} />
                </Field>
                <Field label={<LabelWithHint label='Rule Name' hint='给人看的名称。建议用业务名，例如“售后工单查询”。' />}>
                  <input value={ruleDraft.name} onChange={(e) => setRuleDraft((draft) => ({ ...draft, name: e.target.value }))} />
                </Field>
                <Field label={<LabelWithHint label='Enabled' hint='规则总开关。关闭后，即使微信配置仍然绑定了它，也不会命中。' />}>
                  <select value={String(ruleDraft.enabled)} onChange={(e) => setRuleDraft((draft) => ({ ...draft, enabled: e.target.value === 'true' }))}>
                    <option value='true'>启用</option>
                    <option value='false'>停用</option>
                  </select>
                </Field>
                <Field label={<LabelWithHint label='Match Mode' hint='建议按业务使用：命令式文本用 prefix，关键词命中用 contains，兜底规则才用 all。' />}>
                  <select value={ruleDraft.match.mode} onChange={(e) => setRuleDraft((draft) => ({ ...draft, match: { ...draft.match, mode: e.target.value } }))}>
                    <option value='all'>all</option>
                    <option value='prefix'>prefix</option>
                    <option value='contains'>contains</option>
                    <option value='exact'>exact</option>
                    <option value='regex'>regex</option>
                  </select>
                </Field>
                <Field label={<LabelWithHint label='Match Pattern' hint='示例：`/help`、`退款`、`^订单\\s+\\d+$`。all 模式可以留空。' />} full>
                  <input value={ruleDraft.match.pattern} onChange={(e) => setRuleDraft((draft) => ({ ...draft, match: { ...draft.match, pattern: e.target.value } }))} />
                </Field>
                <Field label={<LabelWithHint label='Description' hint='写清楚这条规则是做什么的、请求哪个系统、是否有特殊返回格式。' />} full>
                  <textarea value={ruleDraft.description} onChange={(e) => setRuleDraft((draft) => ({ ...draft, description: e.target.value }))} />
                </Field>
              </div>
            </div>
          ) : null}

          {ruleStep === 2 ? (
            <div className='modal-section'>
              <div className='form-grid'>
                <Field label={<LabelWithHint label='Method' hint='常见是 GET 或 POST。必须和你的上游接口文档一致。' />}>
                  <input value={ruleDraft.target.method} onChange={(e) => setRuleDraft((draft) => ({ ...draft, target: { ...draft.target, method: e.target.value } }))} />
                </Field>
                <Field label={<LabelWithHint label='Timeout (ms)' hint='示例：5000 或 15000。太短容易误判失败，太长会拖慢微信回复。' />}>
                  <input type='number' value={ruleDraft.target.timeout_ms} onChange={(e) => setRuleDraft((draft) => ({ ...draft, target: { ...draft.target, timeout_ms: Number(e.target.value) } }))} />
                </Field>
                <Field label={<LabelWithHint label='URL Template' hint='示例：`https://api.example.com/v1/query`。支持模板变量。' />} full>
                  <input value={ruleDraft.target.url_template} onChange={(e) => setRuleDraft((draft) => ({ ...draft, target: { ...draft.target, url_template: e.target.value } }))} />
                </Field>
                <Field label={<LabelWithHint label='Skip TLS Verify' hint='只建议内网自签名证书调试时打开。正式环境尽量保持 false。' />}>
                  <select value={String(ruleDraft.target.insecure_skip_tls)} onChange={(e) => setRuleDraft((draft) => ({ ...draft, target: { ...draft.target, insecure_skip_tls: e.target.value === 'true' } }))}>
                    <option value='false'>false</option>
                    <option value='true'>true</option>
                  </select>
                </Field>
              </div>

              <EditorTabs
                tabs={[
                  { id: 'headers', label: 'Headers JSON' },
                  { id: 'query', label: 'Query JSON' },
                  { id: 'body', label: 'Body Template' },
                  { id: 'response', label: 'Response Template' },
                ]}
                current={ruleEditorTab}
                onChange={(tab) => setRuleEditorTab(tab as RuleEditorTab)}
              />

              {ruleEditorTab === 'headers' ? (
                <div className='single-editor top-gap'>
                  <SectionLabel title='Headers JSON' />
                  <CodeEditor value={ruleJsonDrafts.headers} language='json' onChange={(value) => setRuleJsonDrafts((draft) => ({ ...draft, headers: value }))} />
                  <CardHint text='这里填写 HTTP 请求头 JSON。常见示例：Authorization、Content-Type、自定义业务 Header。' />
                </div>
              ) : null}

              {ruleEditorTab === 'query' ? (
                <div className='single-editor top-gap'>
                  <SectionLabel title='Query JSON' />
                  <CodeEditor value={ruleJsonDrafts.query} language='json' onChange={(value) => setRuleJsonDrafts((draft) => ({ ...draft, query: value }))} />
                  <CardHint text='这里填写 URL Query 参数 JSON。它会自动拼到请求地址后面。' />
                </div>
              ) : null}

              {ruleEditorTab === 'body' ? (
                <div className='single-editor top-gap'>
                  <SectionLabel title='Body Template' />
                  <CodeEditor value={ruleDraft.target.body_template} language='json' onChange={(value) => setRuleDraft((draft) => ({ ...draft, target: { ...draft.target, body_template: value } }))} />
                  <CardHint text='这里定义发给上游 API 的请求体模板。可以使用消息、账号、时间等变量。' />
                </div>
              ) : null}

              {ruleEditorTab === 'response' ? (
                <div className='single-editor top-gap'>
                  <SectionLabel title='Response Template' />
                  <CodeEditor value={ruleDraft.response.template} language='handlebars' onChange={(value) => setRuleDraft((draft) => ({ ...draft, response: { ...draft.response, template: value } }))} />
                  <CardHint text='这里决定最终回给微信什么文本。建议只提取上游响应里你真正想让用户看到的字段。' />
                </div>
              ) : null}
            </div>
          ) : null}

          {ruleStep === 3 ? (
            <div className='modal-section'>
              <div className='form-grid'>
                <Field label={<LabelWithHint label='调试账号' hint='用哪个微信配置的上下文来测试这条规则。' />}>
                  <select value={rulePreviewAccountId} onChange={(e) => setRulePreviewAccountId(e.target.value)}>
                    <option value=''>选择一个配置</option>
                    {state.accounts.map((account) => (
                      <option key={account.id} value={account.id}>{account.user_id}</option>
                    ))}
                  </select>
                </Field>
                <Field label={<LabelWithHint label='发送方 User ID' hint='模拟是谁给微信发了这条消息。做会话隔离时很关键。' />}>
                  <input value={rulePreviewUserId} onChange={(e) => setRulePreviewUserId(e.target.value)} />
                </Field>
                <Field label={<LabelWithHint label='样例消息' hint='示例：`查询订单 12345`。会参与规则匹配和模板渲染。' />} full>
                  <textarea value={rulePreviewText} onChange={(e) => setRulePreviewText(e.target.value)} />
                </Field>
              </div>

              <div className='modal-inline-actions'>
                <button className='button secondary' onClick={runPreview} disabled={previewLoading || !rulePreviewAccountId}>
                  <CirclePlay size={16} />
                  {previewLoading ? '调试中…' : '运行调试'}
                </button>
              </div>

              {previewError ? <div className='error-strip'>{previewError}</div> : null}

              {previewResult ? (
                <div className='preview-stack'>
                  <div className='preview-meta'>
                    <span>{previewResult.request_method}</span>
                    <span>{previewResult.request_url}</span>
                    <span>HTTP {previewResult.status_code || 'ERR'}</span>
                    <span>{previewResult.duration_ms} ms</span>
                  </div>
                  <div className='editor-grid'>
                    <div>
                      <SectionLabel title='Rendered Request Body' />
                      <pre className='code-preview'>{previewResult.request_body || '(empty)'}</pre>
                    </div>
                    <div>
                      <SectionLabel title='Rendered Reply' />
                      <pre className='code-preview'>{previewResult.reply || '(empty)'}</pre>
                    </div>
                  </div>
                  <div>
                    <SectionLabel title='Response Body' />
                    <pre className='code-preview'>{previewResult.response_body || '(empty)'}</pre>
                  </div>
                </div>
              ) : (
                <CardHint text='建议排查顺序：先看请求体是否按预期渲染，再看上游返回体，最后看回复模板是否正确提取字段。' />
              )}
            </div>
          ) : null}

          <div className='modal-footer'>
            <div className='modal-step-actions'>
              {ruleStep > 1 ? <button className='button secondary' onClick={() => setRuleStep((step) => (step - 1) as RuleStep)}>上一步</button> : null}
              {ruleStep < 3 ? <button className='button secondary' onClick={() => setRuleStep((step) => (step + 1) as RuleStep)}>下一步</button> : null}
            </div>
            <button className='button primary' onClick={() => void saveRule()}>
              <Save size={16} />
              保存规则
            </button>
          </div>
        </Modal>
      ) : null}

      {configModalOpen ? (
        <Modal title={editingAccountId ? '编辑微信配置' : '新建微信配置'} onClose={() => setConfigModalOpen(false)}>
          <StepTabs
            steps={[
              { id: 1, label: '接口参数' },
              { id: 2, label: '绑定规则' },
              { id: 3, label: '扫码绑定' },
            ]}
            current={configStep}
            onChange={(step) => setConfigStep(step as ConfigStep)}
          />

          {configStep === 1 ? (
            <div className='modal-section'>
              <div className='form-grid'>
                <Field label={<LabelWithHint label='Weixin Base URL' hint='默认一般是 `https://ilinkai.weixin.qq.com`。不要填成你自己的业务 API。' />}>
                  <input value={configDraft.base_url} onChange={(e) => setConfigDraft((draft) => ({ ...draft, base_url: e.target.value }))} />
                </Field>
                <Field label={<LabelWithHint label='Bot Type' hint='大多数情况下保持默认值即可。常见值：`3`。' />}>
                  <input value={configDraft.bot_type} onChange={(e) => setConfigDraft((draft) => ({ ...draft, bot_type: e.target.value }))} />
                </Field>
                <Field label={<LabelWithHint label='Route Tag' hint='只有你明确知道微信接口侧要做灰度或特殊路由时才填。' />} full>
                  <input value={configDraft.route_tag} onChange={(e) => setConfigDraft((draft) => ({ ...draft, route_tag: e.target.value }))} />
                </Field>
              </div>
            </div>
          ) : null}

          {configStep === 2 ? (
            <div className='modal-section'>
              <CardHint text='这里决定这个微信配置能命中哪些 API 规则。收到这个微信账号的消息时，只会在你勾选的规则里继续匹配。' />
              <div className='binding-list top-gap'>
                {state.settings.rules.map((rule) => {
                  const checked = configDraft.rule_ids.includes(rule.id)
                  return (
                    <label key={rule.id} className='binding-row'>
                      <div>
                        <strong>{rule.name}</strong>
                        <span>{rule.description || rule.id}</span>
                      </div>
                      <input type='checkbox' checked={checked} onChange={(e) => toggleConfigRule(rule.id, e.target.checked)} />
                    </label>
                  )
                })}
              </div>
            </div>
          ) : null}

          {configStep === 3 ? (
            <div className='modal-section'>
              {editingAccountId ? (
                <CardHint text='当前是在编辑已存在的微信配置。这里只需要保存绑定规则，不需要重新扫码。' />
              ) : (
                <>
                  <div className='modal-inline-actions'>
                    <button className='button primary' onClick={() => void startConfigLogin()}>
                      <QrCode size={16} />
                      开始扫码绑定
                    </button>
                  </div>
                  {qrURL ? (
                    <div className='qr-panel top-gap'>
                      <img src={qrURL} alt='WeChat QR' />
                    </div>
                  ) : (
                    <CardHint text='先点击“开始扫码绑定”。扫码确认后，会自动创建一个新的微信配置，并套用你刚才选择的规则。' />
                  )}
                </>
              )}
            </div>
          ) : null}

          <div className='modal-footer'>
            <div className='modal-step-actions'>
              {configStep > 1 ? <button className='button secondary' onClick={() => setConfigStep((step) => (step - 1) as ConfigStep)}>上一步</button> : null}
              {configStep < 3 ? <button className='button secondary' onClick={() => setConfigStep((step) => (step + 1) as ConfigStep)}>下一步</button> : null}
            </div>
            {editingAccountId ? (
              <button className='button primary' onClick={() => void saveConfigBindings()}>
                <Save size={16} />
                保存配置
              </button>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </div>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className='modal-backdrop'>
      <section className='modal-shell'>
        <div className='modal-header'>
          <h2>{title}</h2>
          <button className='icon-button' onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className='modal-body'>{children}</div>
      </section>
    </div>
  )
}

function StepTabs({
  steps,
  current,
  onChange,
}: {
  steps: Array<{ id: number; label: string }>
  current: number
  onChange: (step: number) => void
}) {
  return (
    <div className='step-tabs'>
      {steps.map((step) => (
        <button key={step.id} className={`step-tab ${current === step.id ? 'active' : ''}`} onClick={() => onChange(step.id)}>
          {step.id}. {step.label}
        </button>
      ))}
    </div>
  )
}

function EditorTabs({
  tabs,
  current,
  onChange,
}: {
  tabs: Array<{ id: string; label: string }>
  current: string
  onChange: (tab: string) => void
}) {
  return (
    <div className='editor-tabs'>
      {tabs.map((tab) => (
        <button key={tab.id} className={`editor-tab ${current === tab.id ? 'active' : ''}`} onClick={() => onChange(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>
  )
}

function Field({ label, full, children }: { label: React.ReactNode; full?: boolean; children: React.ReactNode }) {
  return (
    <label className={full ? 'field full' : 'field'}>
      <div className='field-label'>{label}</div>
      {children}
    </label>
  )
}

function LabelWithHint({ label, hint }: { label: string; hint: string }) {
  return (
    <span className='label-with-hint'>
      <span>{label}</span>
      <HintBubble content={hint} />
    </span>
  )
}

function HintBubble({ content }: { content: string }) {
  return (
    <span className='hint-bubble' tabIndex={0}>
      <CircleHelp size={14} />
      <span className='hint-popover'>{content}</span>
    </span>
  )
}

function StatusBadge({ live, children }: { live: boolean; children: React.ReactNode }) {
  return <span className={`badge ${live ? 'live' : ''}`}>{children}</span>
}

function CardHint({ text }: { text: string }) {
  return (
    <div className='card-hint'>
      <CheckCircle2 size={16} />
      <span>{text}</span>
    </div>
  )
}

function SectionLabel({ title }: { title: string }) {
  return <div className='section-label'>{title}</div>
}

function CodeEditor({
  value,
  language,
  onChange,
}: {
  value: string
  language: string
  onChange: (value: string) => void
}) {
  return (
    <div className='editor-shell'>
      <Editor
        height='220px'
        defaultLanguage={language}
        value={value}
        theme='vs-dark'
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          lineNumbers: 'on',
          roundedSelection: false,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          wordWrap: 'on',
        }}
        onChange={(next) => onChange(next ?? '')}
      />
    </div>
  )
}

async function apiJSON<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const resp = await fetch(input, init)
  const data = (await resp.json().catch(() => ({}))) as T & { error?: string }
  if (!resp.ok || ('error' in data && typeof data.error === 'string' && data.error)) {
    throw new Error(data.error || `request failed: ${resp.status}`)
  }
  return data
}

function getErrorMessage(error: unknown, fallback = '操作失败') {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  return fallback
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
