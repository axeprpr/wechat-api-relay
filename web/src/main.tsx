import React from 'react'
import ReactDOM from 'react-dom/client'
import Editor from '@monaco-editor/react'
import {
  Bot,
  Cable,
  CheckCircle2,
  ChevronRight,
  CirclePlay,
  CircleStop,
  DatabaseZap,
  MessageSquareCode,
  Plus,
  QrCode,
  Save,
  Settings2,
  Trash2,
  UserRound,
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
}

type PreviewResult = {
  rule_id: string
  request_method: string
  request_url: string
  request_headers: Record<string, string>
  request_query: Record<string, string>
  request_body: string
  status_code: number
  response_body: string
  response_json: Record<string, unknown>
  response_headers: Record<string, unknown>
  reply: string
  duration_ms: number
}

type AppState = {
  settings: Settings
  accounts: Account[]
  runtime: RuntimeState
}

type JsonDrafts = {
  headers: string
  query: string
}

type ViewKey = 'weixin' | 'bindings' | 'rules' | 'detail'

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
  const [selectedRuleId, setSelectedRuleId] = React.useState('')
  const [bindingAccountId, setBindingAccountId] = React.useState('')
  const [currentView, setCurrentView] = React.useState<ViewKey>('weixin')
  const [saving, setSaving] = React.useState(false)
  const [statusMessage, setStatusMessage] = React.useState('Ready')
  const [qrURL, setQrURL] = React.useState('')
  const [loginSession, setLoginSession] = React.useState('')
  const [jsonDrafts, setJsonDrafts] = React.useState<JsonDrafts>({ headers: '{}', query: '{}' })
  const [ruleSearch, setRuleSearch] = React.useState('')
  const [ruleFilter, setRuleFilter] = React.useState<'all' | 'enabled' | 'disabled'>('all')
  const [ruleSort, setRuleSort] = React.useState<'name' | 'method' | 'match' | 'status'>('name')
  const [previewAccountId, setPreviewAccountId] = React.useState('')
  const [previewUserId, setPreviewUserId] = React.useState('debug-user@im.wechat')
  const [previewText, setPreviewText] = React.useState('你好')
  const [previewLoading, setPreviewLoading] = React.useState(false)
  const [previewResult, setPreviewResult] = React.useState<PreviewResult | null>(null)
  const [previewError, setPreviewError] = React.useState('')

  const loadState = React.useCallback(async () => {
    const resp = await fetch('/api/state')
    const data = (await resp.json()) as AppState
    setState(data)
    setSelectedRuleId((current) => current || data.settings.rules[0]?.id || '')
    setBindingAccountId((current) => current || data.settings.active_account_id || data.accounts[0]?.id || '')
  }, [])

  React.useEffect(() => {
    void loadState()
  }, [loadState])

  React.useEffect(() => {
    if (!loginSession) return
    const timer = window.setInterval(async () => {
      const resp = await fetch(`/api/login/status?session_key=${encodeURIComponent(loginSession)}`)
      const data = await resp.json()
      setStatusMessage(`登录状态：${data.status}`)
      if (data.status === 'confirmed') {
        window.clearInterval(timer)
        setLoginSession('')
        setQrURL('')
        setStatusMessage('微信登录成功')
        await loadState()
      }
    }, 2500)
    return () => window.clearInterval(timer)
  }, [loginSession, loadState])

  const selectedRule = state?.settings.rules.find((rule) => rule.id === selectedRuleId) ?? state?.settings.rules[0]
  const activeAccount = state?.accounts.find((account) => account.id === state.settings.active_account_id)
  const selectedBindingAccountId = bindingAccountId || state?.settings.active_account_id || state?.accounts[0]?.id || ''
  const boundRuleIds = state?.settings.account_rules[selectedBindingAccountId] ?? []
  const selectedPreviewAccountId = previewAccountId || state?.settings.active_account_id || state?.accounts[0]?.id || ''

  React.useEffect(() => {
    if (!selectedRule) return
    setJsonDrafts({
      headers: JSON.stringify(selectedRule.target.headers ?? {}, null, 2),
      query: JSON.stringify(selectedRule.target.query ?? {}, null, 2),
    })
  }, [selectedRule?.id])

  React.useEffect(() => {
    setPreviewResult(null)
    setPreviewError('')
  }, [selectedRule?.id])

  if (!state) return <div className='loading'>Loading…</div>

  const filteredRules = [...state.settings.rules]
    .filter((rule) => {
      if (ruleFilter === 'enabled') return rule.enabled
      if (ruleFilter === 'disabled') return !rule.enabled
      return true
    })
    .filter((rule) => {
      const term = ruleSearch.trim().toLowerCase()
      if (!term) return true
      return [rule.name, rule.id, rule.description, rule.match.pattern, rule.target.url_template]
        .join(' ')
        .toLowerCase()
        .includes(term)
    })
    .sort((a, b) => {
      switch (ruleSort) {
        case 'method':
          return a.target.method.localeCompare(b.target.method)
        case 'match':
          return `${a.match.mode}:${a.match.pattern}`.localeCompare(`${b.match.mode}:${b.match.pattern}`)
        case 'status':
          return Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)
        case 'name':
        default:
          return a.name.localeCompare(b.name)
      }
    })

  const updateSettings = (next: Settings) => setState({ ...state, settings: next })

  const updateRule = (patch: Partial<Rule>) => {
    if (!selectedRule) return
    updateSettings({
      ...state.settings,
      rules: state.settings.rules.map((rule) => (rule.id === selectedRule.id ? { ...rule, ...patch } : rule)),
    })
  }

  const updateRuleNested = <K extends keyof Rule>(key: K, value: Rule[K]) => {
    updateRule({ [key]: value } as Partial<Rule>)
  }

  const saveSettings = async () => {
    setSaving(true)
    try {
      const resp = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state.settings),
      })
      const data = await resp.json()
      setState({ ...state, settings: data })
      setStatusMessage('配置已保存')
    } finally {
      setSaving(false)
    }
  }

  const startLogin = async () => {
    const resp = await fetch('/api/login/start', { method: 'POST' })
    const data = await resp.json()
    setQrURL(`/api/login/qr?content=${encodeURIComponent(data.qr_code_url)}`)
    setLoginSession(data.session_key)
    setStatusMessage('请使用微信扫码登录')
  }

  const startRuntime = async () => {
    await fetch('/api/runtime/start', { method: 'POST' })
    await loadState()
    setStatusMessage('中继已启动')
  }

  const stopRuntime = async () => {
    await fetch('/api/runtime/stop', { method: 'POST' })
    await loadState()
    setStatusMessage('中继已停止')
  }

  const addRule = () => {
    const next = emptyRule()
    updateSettings({ ...state.settings, rules: [...state.settings.rules, next] })
    setSelectedRuleId(next.id)
    setCurrentView('detail')
    setStatusMessage('已新增规则')
  }

  const removeRule = () => {
    if (!selectedRule) return
    const rules = state.settings.rules.filter((rule) => rule.id !== selectedRule.id)
    const accountRules = Object.fromEntries(
      Object.entries(state.settings.account_rules).map(([accountID, ruleIDs]) => [
        accountID,
        ruleIDs.filter((id) => id !== selectedRule.id),
      ])
    )
    updateSettings({ ...state.settings, rules, account_rules: accountRules })
    setSelectedRuleId(rules[0]?.id ?? '')
    setStatusMessage('已删除规则')
  }

  const toggleRuleBinding = (accountID: string, ruleID: string, checked: boolean) => {
    const existing = state.settings.account_rules[accountID] ?? []
    const next = checked ? Array.from(new Set([...existing, ruleID])) : existing.filter((id) => id !== ruleID)
    updateSettings({
      ...state.settings,
      account_rules: {
        ...state.settings.account_rules,
        [accountID]: next,
      },
    })
  }

  const applyJsonDraft = (kind: 'headers' | 'query') => {
    if (!selectedRule) return
    try {
      const parsed = JSON.parse(jsonDrafts[kind]) as Record<string, string>
      updateRuleNested('target', { ...selectedRule.target, [kind]: parsed })
      setStatusMessage(`${kind} 已应用`)
    } catch {
      setStatusMessage(`${kind} JSON 格式错误，未保存`)
    }
  }

  const runPreview = async () => {
    if (!selectedRule) return
    setPreviewLoading(true)
    setPreviewResult(null)
    setPreviewError('')
    try {
      const resp = await fetch('/api/rules/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rule: selectedRule,
          account_id: selectedPreviewAccountId,
          user_id: previewUserId,
          text: previewText,
        }),
      })
      const data = await resp.json()
      setPreviewResult((data.result as PreviewResult) ?? null)
      setPreviewError((data.error as string) ?? '')
      setStatusMessage(data.ok ? '规则调试完成' : '规则调试返回错误')
    } finally {
      setPreviewLoading(false)
    }
  }

  return (
    <div className='workspace'>
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
          <div className='sidebar-nav-title'>导航</div>
          <button className={`sidebar-nav-item ${currentView === 'weixin' ? 'active' : ''}`} onClick={() => setCurrentView('weixin')}>
            <Settings2 size={16} />
            微信配置
          </button>
          <button className={`sidebar-nav-item ${currentView === 'bindings' ? 'active' : ''}`} onClick={() => setCurrentView('bindings')}>
            <UserRound size={16} />
            账号绑定
          </button>
          <button className={`sidebar-nav-item ${currentView === 'rules' ? 'active' : ''}`} onClick={() => setCurrentView('rules')}>
            <DatabaseZap size={16} />
            规则表
          </button>
          <button className={`sidebar-nav-item ${currentView === 'detail' ? 'active' : ''}`} onClick={() => setCurrentView('detail')}>
            <MessageSquareCode size={16} />
            规则详情
          </button>
        </nav>

        <div className='sidebar-card compact'>
          <div className='sidebar-section-title'>运行状态</div>
          <StatusBadge live={state.runtime.running}>{state.runtime.running ? 'Relay Running' : 'Relay Stopped'}</StatusBadge>
          <div className='sidebar-meta'>
            <div>
              <span>活动账号</span>
              <strong>{activeAccount?.user_id || '未选择'}</strong>
            </div>
            <div>
              <span>已绑定规则</span>
              <strong>{(state.settings.account_rules[state.settings.active_account_id] || []).length}</strong>
            </div>
          </div>
        </div>
      </aside>

      <main className='main'>
        <header className='page-header'>
          <div>
            <h1>任意 API Relay 控制台</h1>
            <p>通过 OpenClaw 微信接口接入微信消息，并把它按规则转发到任意 HTTP API。</p>
          </div>
          <button className='button primary' onClick={saveSettings} disabled={saving}>
            <Save size={16} />
            {saving ? '保存中…' : '保存配置'}
          </button>
        </header>

        <section className='summary-grid'>
          <SummaryCard icon={<Cable size={16} />} title='微信通道' value={state.settings.weixin.base_url} note='通过 OpenClaw 微信接口长轮询收发消息' />
          <SummaryCard icon={<UserRound size={16} />} title='账号' value={activeAccount?.user_id || '未绑定微信'} note='先扫码登录，再选择活动账号' />
          <SummaryCard icon={<DatabaseZap size={16} />} title='规则' value={`${state.settings.rules.length} 条`} note='每个微信账号可绑定不同规则集合' />
        </section>

        <div className='view-shell'>
          {currentView === 'weixin' && (
            <section className='view-grid single'>
              <Card title='微信配置' description='这部分只管接微信，不碰你的业务 API。' action={<button className='button secondary' onClick={startLogin}><QrCode size={16} />开始扫码</button>}>
                <div className='form-grid'>
                  <Field label='Weixin Base URL'>
                    <input value={state.settings.weixin.base_url} onChange={(e) => updateSettings({ ...state.settings, weixin: { ...state.settings.weixin, base_url: e.target.value } })} />
                  </Field>
                  <Field label='Bot Type'>
                    <input value={state.settings.weixin.bot_type} onChange={(e) => updateSettings({ ...state.settings, weixin: { ...state.settings.weixin, bot_type: e.target.value } })} />
                  </Field>
                  <Field label='Route Tag'>
                    <input value={state.settings.weixin.route_tag} onChange={(e) => updateSettings({ ...state.settings, weixin: { ...state.settings.weixin, route_tag: e.target.value } })} />
                  </Field>
                  <Field label='Active Account'>
                    <select value={state.settings.active_account_id} onChange={(e) => updateSettings({ ...state.settings, active_account_id: e.target.value })}>
                      <option value=''>选择一个账号</option>
                      {state.accounts.map((account) => (
                        <option key={account.id} value={account.id}>{account.id} / {account.user_id}</option>
                      ))}
                    </select>
                  </Field>
                </div>

                {qrURL && (
                  <div className='qr-panel'>
                    <img src={qrURL} alt='WeChat QR' />
                  </div>
                )}
              </Card>

              <Card title='运行控制' description='扫码完成后，选择活动账号，再启动中继。' action={<StatusBadge live={state.runtime.running}>{state.runtime.running ? '运行中' : '已停止'}</StatusBadge>}>
                <div className='action-row'>
                  <button className='button primary' onClick={startRuntime}><CirclePlay size={16} />启动 Relay</button>
                  <button className='button secondary' onClick={stopRuntime}><CircleStop size={16} />停止 Relay</button>
                </div>
                <div className='status-strip'>
                  <CheckCircle2 size={16} />
                  {statusMessage}
                </div>
              </Card>
            </section>
          )}

          {currentView === 'bindings' && (
            <section className='view-grid single'>
              <Card title='账号绑定规则' description='一个微信账号可以绑定多条规则，不同账号也可以绑定不同规则。'>
                <div className='form-grid'>
                  <Field label='选择微信账号' full>
                    <select value={selectedBindingAccountId} onChange={(e) => setBindingAccountId(e.target.value)}>
                      <option value=''>选择一个账号</option>
                      {state.accounts.map((account) => (
                        <option key={account.id} value={account.id}>{account.id} / {account.user_id}</option>
                      ))}
                    </select>
                  </Field>
                </div>

                <div className='binding-list'>
                  {state.settings.rules.map((rule) => {
                    const checked = boundRuleIds.includes(rule.id)
                    return (
                      <label key={rule.id} className='binding-row'>
                        <div>
                          <strong>{rule.name}</strong>
                          <span>{rule.description || rule.id}</span>
                        </div>
                        <input type='checkbox' checked={checked} onChange={(e) => toggleRuleBinding(selectedBindingAccountId, rule.id, e.target.checked)} disabled={!selectedBindingAccountId} />
                      </label>
                    )
                  })}
                </div>
              </Card>
            </section>
          )}

          {currentView === 'rules' && (
            <section className='view-grid single'>
              <Card title='规则表' description='这里是规则总表。先建规则，再绑定到具体微信账号。' action={<button className='button secondary' onClick={addRule}><Plus size={16} />新建规则</button>}>
                <div className='table-toolbar'>
                  <input className='toolbar-search' placeholder='搜索规则名称、ID、URL 或匹配词' value={ruleSearch} onChange={(e) => setRuleSearch(e.target.value)} />
                  <select value={ruleFilter} onChange={(e) => setRuleFilter(e.target.value as 'all' | 'enabled' | 'disabled')}>
                    <option value='all'>全部状态</option>
                    <option value='enabled'>仅启用</option>
                    <option value='disabled'>仅停用</option>
                  </select>
                  <select value={ruleSort} onChange={(e) => setRuleSort(e.target.value as 'name' | 'method' | 'match' | 'status')}>
                    <option value='name'>按名称</option>
                    <option value='method'>按方法</option>
                    <option value='match'>按匹配</option>
                    <option value='status'>按状态</option>
                  </select>
                  <div className='table-meta'>共 {filteredRules.length} 条</div>
                </div>
                <div className='rules-table'>
                  <div className='rules-table-head'>
                    <span>名称</span>
                    <span>匹配</span>
                    <span>方法</span>
                    <span>状态</span>
                  </div>
                  {filteredRules.map((rule) => (
                    <button
                      key={rule.id}
                      className={`rules-table-row ${selectedRule?.id === rule.id ? 'selected' : ''}`}
                      onClick={() => {
                        setSelectedRuleId(rule.id)
                        setCurrentView('detail')
                      }}
                    >
                      <div className='title-col'>
                        <strong>{rule.name}</strong>
                        <span>{rule.id}</span>
                      </div>
                      <span>{rule.match.mode} / {rule.match.pattern || '*'}</span>
                      <span>{rule.target.method}</span>
                      <StatusBadge live={rule.enabled}>{rule.enabled ? '启用' : '停用'}</StatusBadge>
                    </button>
                  ))}
                  {filteredRules.length === 0 ? <div className='empty-state'>没有符合当前筛选条件的规则。</div> : null}
                </div>
              </Card>
            </section>
          )}

          {currentView === 'detail' && (
            <section className='view-grid detail'>
              <section className='column'>
                {selectedRule ? (
                  <>
                    <Card title='规则基本信息' description='规则本身只定义如何匹配与如何请求。它是否生效，由账号绑定关系决定。' action={<button className='button danger' onClick={removeRule}><Trash2 size={16} />删除规则</button>}>
                      <div className='form-grid'>
                        <Field label='Rule ID'><input value={selectedRule.id} onChange={(e) => updateRule({ id: e.target.value })} /></Field>
                        <Field label='Rule Name'><input value={selectedRule.name} onChange={(e) => updateRule({ name: e.target.value })} /></Field>
                        <Field label='Enabled'>
                          <select value={String(selectedRule.enabled)} onChange={(e) => updateRule({ enabled: e.target.value === 'true' })}>
                            <option value='true'>启用</option>
                            <option value='false'>停用</option>
                          </select>
                        </Field>
                        <Field label='Match Mode'>
                          <select value={selectedRule.match.mode} onChange={(e) => updateRuleNested('match', { ...selectedRule.match, mode: e.target.value })}>
                            <option value='all'>all</option>
                            <option value='prefix'>prefix</option>
                            <option value='contains'>contains</option>
                            <option value='exact'>exact</option>
                            <option value='regex'>regex</option>
                          </select>
                        </Field>
                        <Field label='Match Pattern' full>
                          <input value={selectedRule.match.pattern} onChange={(e) => updateRuleNested('match', { ...selectedRule.match, pattern: e.target.value })} />
                        </Field>
                        <Field label='Description' full>
                          <textarea value={selectedRule.description} onChange={(e) => updateRule({ description: e.target.value })} />
                        </Field>
                      </div>
                    </Card>

                    <Card title='HTTP 请求' description='URL / Method / Timeout 这些是请求骨架。'>
                      <div className='form-grid'>
                        <Field label='Method'><input value={selectedRule.target.method} onChange={(e) => updateRuleNested('target', { ...selectedRule.target, method: e.target.value })} /></Field>
                        <Field label='Timeout (ms)'><input type='number' value={selectedRule.target.timeout_ms} onChange={(e) => updateRuleNested('target', { ...selectedRule.target, timeout_ms: Number(e.target.value) })} /></Field>
                        <Field label='URL Template' full><input value={selectedRule.target.url_template} onChange={(e) => updateRuleNested('target', { ...selectedRule.target, url_template: e.target.value })} /></Field>
                        <Field label='Skip TLS Verify'>
                          <select value={String(selectedRule.target.insecure_skip_tls)} onChange={(e) => updateRuleNested('target', { ...selectedRule.target, insecure_skip_tls: e.target.value === 'true' })}>
                            <option value='false'>false</option>
                            <option value='true'>true</option>
                          </select>
                        </Field>
                      </div>
                    </Card>
                  </>
                ) : (
                  <Card title='没有规则' description='先新建一条规则。'>
                    <button className='button primary' onClick={addRule}><Plus size={16} />新建第一条规则</button>
                  </Card>
                )}
              </section>

              <section className='column'>
                {selectedRule ? (
                  <>
                    <Card title='Headers / Query' description='用 VS Code 风格编辑器编辑 JSON，失焦时应用。'>
                      <div className='editor-grid'>
                        <div>
                          <SectionLabel title='Headers JSON' />
                          <CodeEditor value={jsonDrafts.headers} language='json' onChange={(value) => setJsonDrafts((current) => ({ ...current, headers: value }))} onBlur={() => applyJsonDraft('headers')} />
                        </div>
                        <div>
                          <SectionLabel title='Query JSON' />
                          <CodeEditor value={jsonDrafts.query} language='json' onChange={(value) => setJsonDrafts((current) => ({ ...current, query: value }))} onBlur={() => applyJsonDraft('query')} />
                        </div>
                      </div>
                    </Card>

                    <Card title='Body / Response Template' description='左边发上游，右边决定回微信什么。'>
                      <div className='editor-grid'>
                        <div>
                          <SectionLabel title='Body Template' />
                          <CodeEditor value={selectedRule.target.body_template} language='json' onChange={(value) => updateRuleNested('target', { ...selectedRule.target, body_template: value })} />
                        </div>
                        <div>
                          <SectionLabel title='Response Template' />
                          <CodeEditor value={selectedRule.response.template} language='handlebars' onChange={(value) => updateRuleNested('response', { ...selectedRule.response, template: value })} />
                        </div>
                      </div>
                    </Card>

                    <Card title='当前关系' description='当前编辑的规则会被哪些账号使用，一眼看清。'>
                      <div className='relation-list'>
                        {state.accounts.map((account) => {
                          const using = (state.settings.account_rules[account.id] ?? []).includes(selectedRule.id)
                          return (
                            <div key={account.id} className='relation-row'>
                              <div>
                                <strong>{account.user_id}</strong>
                                <span>{account.id}</span>
                              </div>
                              <div className='relation-state'>
                                <ChevronRight size={14} />
                                <StatusBadge live={using}>{using ? '已绑定' : '未绑定'}</StatusBadge>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </Card>

                    <Card title='模板上下文' description='这是当前规则可用的模板变量。'>
                      <CodePreview />
                    </Card>

                    <Card title='规则调试' description='用一个样例消息实际请求上游，直接看渲染后的请求与最终回微信文本。' action={<button className='button primary' onClick={runPreview} disabled={previewLoading || !selectedPreviewAccountId}><CirclePlay size={16} />{previewLoading ? '调试中…' : '运行调试'}</button>}>
                      <div className='form-grid'>
                        <Field label='调试账号'>
                          <select value={selectedPreviewAccountId} onChange={(e) => setPreviewAccountId(e.target.value)}>
                            <option value=''>选择一个账号</option>
                            {state.accounts.map((account) => (
                              <option key={account.id} value={account.id}>{account.id} / {account.user_id}</option>
                            ))}
                          </select>
                        </Field>
                        <Field label='发送方 User ID'>
                          <input value={previewUserId} onChange={(e) => setPreviewUserId(e.target.value)} />
                        </Field>
                        <Field label='样例消息' full>
                          <textarea value={previewText} onChange={(e) => setPreviewText(e.target.value)} />
                        </Field>
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

                          <div className='editor-grid'>
                            <div>
                              <SectionLabel title='Request Headers' />
                              <pre className='code-preview'>{JSON.stringify(previewResult.request_headers ?? {}, null, 2)}</pre>
                            </div>
                            <div>
                              <SectionLabel title='Response Body' />
                              <pre className='code-preview'>{previewResult.response_body || '(empty)'}</pre>
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </Card>
                  </>
                ) : null}
              </section>
            </section>
          )}
        </div>
      </main>
    </div>
  )
}

function Card({
  title,
  description,
  action,
  children,
}: {
  title: string
  description?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className='card'>
      <div className='card-header'>
        <div>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {action}
      </div>
      <div className='card-content'>{children}</div>
    </section>
  )
}

function Field({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return (
    <label className={full ? 'field full' : 'field'}>
      <span>{label}</span>
      {children}
    </label>
  )
}

function StatusBadge({ live, children }: { live: boolean; children: React.ReactNode }) {
  return <span className={`badge ${live ? 'live' : ''}`}>{children}</span>
}

function SummaryCard({
  icon,
  title,
  value,
  note,
}: {
  icon: React.ReactNode
  title: string
  value: string
  note: string
}) {
  return (
    <div className='summary-card'>
      <div className='summary-icon'>{icon}</div>
      <div>
        <div className='summary-title'>{title}</div>
        <div className='summary-value'>{value}</div>
        <div className='summary-note'>{note}</div>
      </div>
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
  onBlur,
}: {
  value: string
  language: string
  onChange: (value: string) => void
  onBlur?: () => void
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
        onMount={(editor) => {
          editor.onDidBlurEditorText(() => onBlur?.())
        }}
      />
    </div>
  )
}

function CodePreview() {
  return (
    <pre className='code-preview'>{`{{ .Message.text }}
{{ .Message.from }}
{{ .Message.context_token }}
{{ .Account.id }}
{{ .Account.raw_id }}
{{ .Account.user_id }}
{{ .Now.rfc3339 }}

{{ .Response.status_code }}
{{ .Response.body }}
{{ .Response.json }}
{{ .Response.headers }}`}</pre>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
