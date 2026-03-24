import React from 'react'
import ReactDOM from 'react-dom/client'
import Editor from '@monaco-editor/react'
import {
  Bot,
  ChevronDown,
  CircleHelp,
  FilePenLine,
  LoaderCircle,
  MessageSquareCode,
  Plus,
  Power,
  QrCode,
  Search,
  Trash2,
  Wifi,
  WifiOff,
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
  created_at: string
  updated_at: string
  saved_at: string
}

type RuntimeState = {
  running: boolean
  account_id: string
  running_account_ids: string[]
  account_statuses: Record<
    string,
    {
      running: boolean
      last_inbound_at?: string
      last_inbound_text?: string
      last_reply_at?: string
      last_reply_text?: string
      last_rule_id?: string
      last_error_at?: string
      last_error?: string
    }
  >
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

type ToastKind = 'success' | 'error' | 'info'
type ToastItem = { id: number; kind: ToastKind; message: string }

const emptyRule = (): Rule => ({
  id: `rule-${Math.random().toString(36).slice(2, 8)}`,
  name: '新规则',
  description: '',
  enabled: true,
  match: { mode: 'all', pattern: '' },
  target: {
    method: 'POST',
    url_template: 'https://api.openai.com/v1/chat/completions',
    headers: {
      Authorization: 'Bearer 你的Key',
      'Content-Type': 'application/json',
    },
    query: {},
    body_template:
      '{\n  "model": "Qwen3.5-27B-FP8",\n  "messages": [\n    {\n      "role": "user",\n      "content": "{{ .Message.text }}"\n    }\n  ]\n}',
    timeout_ms: 60000,
    insecure_skip_tls: false,
  },
  response: {
    template: '{{ index (index .Response.json "choices") 0 "message" "content" }}',
  },
  conversation: {
    save_history: false,
    history_limit: 12,
  },
})

function App() {
  const [state, setState] = React.useState<AppState | null>(null)
  const [currentView, setCurrentView] = React.useState<ViewKey>(() => {
    const saved = window.localStorage.getItem('wechat-api-relay:view')
    return saved === 'weixin' ? 'weixin' : 'rules'
  })
  const [toasts, setToasts] = React.useState<ToastItem[]>([])

  const [ruleSearch, setRuleSearch] = React.useState('')
  const [ruleModalOpen, setRuleModalOpen] = React.useState(false)
  const [ruleStep, setRuleStep] = React.useState<RuleStep>(1)
  const [ruleEditorTab, setRuleEditorTab] = React.useState<RuleEditorTab>('headers')
  const [ruleDraft, setRuleDraft] = React.useState<RuleDraft>(emptyRule())
  const [ruleJsonDrafts, setRuleJsonDrafts] = React.useState<JsonDrafts>({ headers: '{}', query: '{}' })
  const [editingRuleId, setEditingRuleId] = React.useState('')

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
  const [savingConfig, setSavingConfig] = React.useState(false)
  const [loginLoading, setLoginLoading] = React.useState(false)
  const [accountSearch, setAccountSearch] = React.useState('')
  const loginHandledRef = React.useRef('')
  const loginPollingRef = React.useRef(false)

  const toast = React.useCallback((kind: ToastKind, message: string) => {
    const item = { id: Date.now() + Math.floor(Math.random() * 1000), kind, message }
    setToasts((current) => [...current, item])
  }, [])

  React.useEffect(() => {
    if (toasts.length === 0) return
    const timer = window.setTimeout(() => {
      setToasts((current) => current.slice(1))
    }, 3200)
    return () => window.clearTimeout(timer)
  }, [toasts])

  const loadState = React.useCallback(async () => {
    const data = await apiJSON<AppState>('/api/state')
    setState(data)
  }, [])

  React.useEffect(() => {
    void loadState()
  }, [loadState])

  React.useEffect(() => {
    window.localStorage.setItem('wechat-api-relay:view', currentView)
  }, [currentView])

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
      if (loginPollingRef.current) return
      loginPollingRef.current = true
      try {
        const params = new URLSearchParams({ session_key: loginSession })
        if (editingAccountId) params.set('target_account_id', editingAccountId)
        const data = await apiJSON<{ status: string; account_id?: string }>(`/api/login/status?${params.toString()}`)
        if (data.status === 'confirmed') {
          if (loginHandledRef.current === loginSession) {
            return
          }
          loginHandledRef.current = loginSession
          window.clearInterval(timer)
          setLoginSession('')
          setLoginLoading(false)
          setQrURL('')
          if (data.account_id && pendingRuleIDs.length > 0) {
            await bindRulesAfterLogin(data.account_id, pendingRuleIDs)
            setPendingRuleIDs([])
          }
          await loadState()
          toast('success', editingAccountId ? '微信配置已重新绑定' : '微信配置创建成功')
        }
      } catch (error) {
        window.clearInterval(timer)
        setLoginSession('')
        setLoginLoading(false)
        toast('error', getErrorMessage(error))
      } finally {
        loginPollingRef.current = false
      }
    }, 2500)
    return () => {
      window.clearInterval(timer)
      loginPollingRef.current = false
    }
  }, [bindRulesAfterLogin, editingAccountId, loadState, loginSession, pendingRuleIDs, toast])

  const persistSettings = React.useCallback(
    async (nextSettings: Settings) => {
      const data = await apiJSON<Settings>('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nextSettings),
      })
      setState((current) => (current ? { ...current, settings: data } : current))
      return data
    },
    []
  )

  if (!state) {
    return (
      <div className='app-shell loading-shell'>
        <div className='loading-card'>正在加载管理台…</div>
      </div>
    )
  }

  const filteredRules = state.settings.rules.filter((rule) => {
    const term = ruleSearch.trim().toLowerCase()
    if (!term) return true
    return [rule.id, rule.name, rule.description, rule.match.pattern, rule.target.url_template]
      .join(' ')
      .toLowerCase()
      .includes(term)
  })

  const filteredAccounts = state.accounts.filter((account) => {
    const term = accountSearch.trim().toLowerCase()
    if (!term) return true
    return [account.id, account.user_id, account.raw_id].join(' ').toLowerCase().includes(term)
  })

  const openCreateRule = () => {
    const next = emptyRule()
    setEditingRuleId('')
    setRuleDraft(next)
    setRuleJsonDrafts({
      headers: JSON.stringify(next.target.headers, null, 2),
      query: JSON.stringify(next.target.query, null, 2),
    })
    setRuleEditorTab('headers')
    setRuleStep(1)
    setRuleModalOpen(true)
  }

  const openEditRule = (rule: Rule) => {
    setEditingRuleId(rule.id)
    setRuleDraft(structuredClone(rule))
    setRuleJsonDrafts({
      headers: JSON.stringify(rule.target.headers ?? {}, null, 2),
      query: JSON.stringify(rule.target.query ?? {}, null, 2),
    })
    setRuleEditorTab('headers')
    setRuleStep(1)
    setRuleModalOpen(true)
  }

  const saveRule = async () => {
    try {
      const headers = JSON.parse(ruleJsonDrafts.headers) as Record<string, string>
      const query = JSON.parse(ruleJsonDrafts.query) as Record<string, string>
      const nextRule = { ...ruleDraft, target: { ...ruleDraft.target, headers, query } }
      const exists = state.settings.rules.some((rule) => rule.id === nextRule.id)
      const nextRules = exists
        ? state.settings.rules.map((rule) => (rule.id === nextRule.id ? nextRule : rule))
        : [...state.settings.rules, nextRule]
      await persistSettings({ ...state.settings, rules: nextRules })
      setRuleModalOpen(false)
      toast('success', exists ? '规则已更新' : '规则已创建')
    } catch (error) {
      toast('error', getErrorMessage(error, '请求头 JSON 或查询参数 JSON 不是合法内容'))
    }
  }

  const deleteRule = async (ruleID: string) => {
    try {
      const nextRules = state.settings.rules.filter((rule) => rule.id !== ruleID)
      const accountRules = Object.fromEntries(
        Object.entries(state.settings.account_rules).map(([accountID, ruleIDs]) => [
          accountID,
          ruleIDs.filter((id) => id !== ruleID),
        ])
      )
      await persistSettings({ ...state.settings, rules: nextRules, account_rules: accountRules })
      toast('success', '规则已删除')
    } catch (error) {
      toast('error', getErrorMessage(error))
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
    setLoginSession('')
    setQrURL('')
    setPendingRuleIDs([])
    setConfigModalOpen(true)
  }

  const openEditConfig = (account: Account) => {
    setEditingAccountId(account.id)
    setConfigDraft({
      base_url: state.settings.weixin.base_url,
      bot_type: state.settings.weixin.bot_type,
      route_tag: state.settings.weixin.route_tag,
      rule_ids: state.settings.account_rules[account.id] ?? [],
    })
    setConfigStep(1)
    setLoginSession('')
    setQrURL('')
    setPendingRuleIDs([])
    setConfigModalOpen(true)
  }

  const saveConfigBindings = async () => {
    try {
      setSavingConfig(true)
      if (!editingAccountId) {
        toast('info', '新建配置需要先扫码绑定，扫码成功后会自动保存规则绑定')
        return
      }
      const nextSettings: Settings = {
        ...state.settings,
        account_rules: {
          ...state.settings.account_rules,
          [editingAccountId]: configDraft.rule_ids,
        },
      }
      await persistSettings(nextSettings)
      setConfigModalOpen(false)
      toast('success', '微信配置已保存')
    } catch (error) {
      toast('error', getErrorMessage(error))
    } finally {
      setSavingConfig(false)
    }
  }

  const startConfigLogin = async () => {
    try {
      setLoginLoading(true)
      loginHandledRef.current = ''
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
      toast('info', '二维码已生成，请扫码绑定')
    } catch (error) {
      setLoginLoading(false)
      toast('error', getErrorMessage(error))
    }
  }

  const setAccountOnline = async (accountID: string) => {
    try {
      await persistSettings({ ...state.settings, active_account_id: accountID })
      setState((current) =>
        current
          ? {
              ...current,
              runtime: {
                ...current.runtime,
                running: true,
                account_id: accountID,
                running_account_ids: Array.from(new Set([...(current.runtime.running_account_ids ?? []), accountID])),
                account_statuses: {
                  ...(current.runtime.account_statuses ?? {}),
                  [accountID]: {
                    ...(current.runtime.account_statuses?.[accountID] ?? {}),
                    running: true,
                  },
                },
              },
            }
          : current
      )
      await apiJSON(`/api/runtime/start?account_id=${encodeURIComponent(accountID)}`, { method: 'POST' })
      await loadState()
      toast('success', '微信配置已上线')
    } catch (error) {
      toast('error', getErrorMessage(error))
    }
  }

  const setAccountOffline = async (accountID: string) => {
    try {
      setState((current) =>
        current
          ? {
              ...current,
              runtime: {
                ...current.runtime,
                running_account_ids: (current.runtime.running_account_ids ?? []).filter((id) => id !== accountID),
                account_id: current.runtime.account_id === accountID ? '' : current.runtime.account_id,
                running: (current.runtime.running_account_ids ?? []).some((id) => id !== accountID),
                account_statuses: {
                  ...(current.runtime.account_statuses ?? {}),
                  [accountID]: {
                    ...(current.runtime.account_statuses?.[accountID] ?? {}),
                    running: false,
                  },
                },
              },
            }
          : current
      )
      await apiJSON(`/api/runtime/stop?account_id=${encodeURIComponent(accountID)}`, { method: 'POST' })
      await loadState()
      toast('success', '微信配置已下线')
    } catch (error) {
      toast('error', getErrorMessage(error))
    }
  }

  const deleteAccount = async (accountID: string) => {
    try {
      await apiJSON<AppState>(`/api/accounts/delete?account_id=${encodeURIComponent(accountID)}`, { method: 'POST' })
      await loadState()
      setConfigModalOpen(false)
      toast('success', '微信配置已删除')
    } catch (error) {
      toast('error', getErrorMessage(error))
    }
  }

  const toggleConfigRule = (ruleID: string, checked: boolean) => {
    const next = checked
      ? Array.from(new Set([...configDraft.rule_ids, ruleID]))
      : configDraft.rule_ids.filter((id) => id !== ruleID)
    setConfigDraft((draft) => ({ ...draft, rule_ids: next }))
  }

  return (
    <div className='app-shell'>
      <aside className='side-panel'>
        <div className='brand-card'>
          <div className='brand-logo'>
            <Bot size={18} />
          </div>
          <div>
            <div className='brand-name'>微信接口接入</div>
            <div className='brand-subtitle'>基于 OpenClaw 微信链路</div>
          </div>
        </div>

        <nav className='nav-group'>
          <button className={`nav-item ${currentView === 'rules' ? 'active' : ''}`} onClick={() => setCurrentView('rules')}>
            <MessageSquareCode size={16} />
            API 规则
          </button>
          <button className={`nav-item ${currentView === 'weixin' ? 'active' : ''}`} onClick={() => setCurrentView('weixin')}>
            <Wifi size={16} />
            微信配置
          </button>
        </nav>

        <div className='side-footer'>
          <div className='side-stat'>
            <span>规则数</span>
            <strong>{state.settings.rules.length}</strong>
          </div>
          <div className='side-stat'>
            <span>微信配置</span>
            <strong>{state.accounts.length}</strong>
          </div>
        </div>
      </aside>

      <main className='content-shell'>
        {currentView === 'rules' ? (
          <section className='page-panel'>
            <PageHeader
              title='API 规则'
              description='定义微信消息该如何匹配、调用哪个接口，以及最终回复什么内容。'
              action={
                <button className='btn btn-primary' onClick={openCreateRule}>
                  <Plus size={16} />
                  新建规则
                </button>
              }
            />

            <div className='toolbar-card'>
              <div className='search-box'>
                <Search size={16} />
                <input
                  value={ruleSearch}
                  onChange={(e) => setRuleSearch(e.target.value)}
                  placeholder='搜索规则名称、编号、匹配词或接口地址'
                />
              </div>
            </div>

            <div className='data-card'>
              <div className='table-scroll'>
                <table className='data-table'>
                  <thead>
                    <tr>
                      <th>规则名称</th>
                      <th>匹配方式</th>
                      <th>请求目标</th>
                      <th>状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRules.map((rule) => (
                      <tr key={rule.id}>
                        <td>
                          <div className='primary-cell'>
                            <strong>{rule.name}</strong>
                            <span>{rule.id}</span>
                          </div>
                        </td>
                        <td>{matchModeLabel(rule.match.mode)} / {rule.match.pattern || '*'}</td>
                        <td className='mono-cell'>{rule.target.method} {rule.target.url_template || '(未填写)'}</td>
                        <td>
                          <StatusChip live={rule.enabled}>{rule.enabled ? '启用' : '停用'}</StatusChip>
                        </td>
                        <td>
                          <div className='table-actions'>
                            <IconActionButton label='编辑规则' onClick={() => openEditRule(rule)}>
                              <FilePenLine size={15} />
                            </IconActionButton>
                            <IconActionButton label='删除规则' tone='danger' onClick={() => void deleteRule(rule.id)}>
                              <Trash2 size={15} />
                            </IconActionButton>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {filteredRules.length === 0 ? <EmptyBlock title='还没有规则' text='点击右上角“新建规则”开始配置。' /> : null}
            </div>
          </section>
        ) : (
          <section className='page-panel'>
            <PageHeader
              title='微信配置'
              description='每条微信配置代表一个已扫码绑定的微信账号，可以独立绑定规则，并单独上线或下线。'
              action={
                <button className='btn btn-primary' onClick={openCreateConfig}>
                  <Plus size={16} />
                  新建配置
                </button>
              }
            />

            <div className='toolbar-card'>
              <div className='search-box'>
                <Search size={16} />
                <input
                  value={accountSearch}
                  onChange={(e) => setAccountSearch(e.target.value)}
                  placeholder='搜索微信账号、配置编号'
                />
              </div>
            </div>

            <div className='data-card'>
              <div className='table-scroll'>
                <table className='data-table'>
                  <thead>
                    <tr>
                      <th>微信账号</th>
                      <th>创建时间</th>
                      <th>更新时间</th>
                      <th>绑定规则</th>
                      <th>状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAccounts.map((account) => {
                      const isOnline = (state.runtime.running_account_ids ?? []).includes(account.id)
                      const ruleIDs = state.settings.account_rules[account.id] ?? []
                      return (
                        <tr key={account.id}>
                          <td>
                            <div className='primary-cell'>
                              <strong>{account.user_id || '(未识别用户)'}</strong>
                              <span>{account.id}</span>
                            </div>
                          </td>
                          <td>{formatTime(account.created_at || account.saved_at)}</td>
                          <td>{formatTime(account.updated_at || account.saved_at)}</td>
                          <td>{ruleIDs.length} 条</td>
                          <td>
                            <StatusChip live={isOnline}>{isOnline ? '在线' : '离线'}</StatusChip>
                          </td>
                          <td>
                            <div className='table-actions'>
                              <IconActionButton label='编辑配置' onClick={() => openEditConfig(account)}>
                                <FilePenLine size={15} />
                              </IconActionButton>
                              {isOnline ? (
                                <IconActionButton label='下线' tone='danger' onClick={() => void setAccountOffline(account.id)}>
                                  <WifiOff size={15} />
                                </IconActionButton>
                              ) : (
                                <IconActionButton label='上线' tone='success' onClick={() => void setAccountOnline(account.id)}>
                                  <Power size={15} />
                                </IconActionButton>
                              )}
                              <IconActionButton label='删除配置' tone='danger' onClick={() => void deleteAccount(account.id)}>
                                <Trash2 size={15} />
                              </IconActionButton>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {filteredAccounts.length === 0 ? <EmptyBlock title='还没有微信配置' text='点击右上角“新建配置”，然后扫码绑定一个微信账号。' /> : null}
            </div>
          </section>
        )}
      </main>

      {ruleModalOpen ? (
        <DialogShell title={editingRuleId ? '编辑规则' : '新建规则'} onClose={() => setRuleModalOpen(false)} width='wide'>
          <StepStrip
            steps={[
              { id: 1, label: '基本信息' },
              { id: 2, label: '请求配置' },
              { id: 3, label: '回复设置' },
            ]}
            current={ruleStep}
          />

          {ruleStep === 1 ? (
            <div className='dialog-grid'>
              <FormField label='规则编号'>
                <input value={ruleDraft.id} onChange={(e) => setRuleDraft((draft) => ({ ...draft, id: e.target.value }))} />
              </FormField>
              <FormField label='规则名称'>
                <input value={ruleDraft.name} onChange={(e) => setRuleDraft((draft) => ({ ...draft, name: e.target.value }))} />
              </FormField>
              <FormField label='是否启用'>
                <SelectControl
                  value={String(ruleDraft.enabled)}
                  onChange={(value) => setRuleDraft((draft) => ({ ...draft, enabled: value === 'true' }))}
                  options={[
                    { value: 'true', label: '启用' },
                    { value: 'false', label: '停用' },
                  ]}
                />
              </FormField>
              <FormField label='匹配方式' hint='兜底规则才建议用“全部匹配”，命令类消息更适合用“前缀匹配”或“完全匹配”。'>
                <SelectControl
                  value={ruleDraft.match.mode}
                  onChange={(value) => setRuleDraft((draft) => ({ ...draft, match: { ...draft.match, mode: value } }))}
                  options={[
                    { value: 'all', label: '全部匹配' },
                    { value: 'prefix', label: '前缀匹配' },
                    { value: 'contains', label: '包含匹配' },
                    { value: 'exact', label: '完全匹配' },
                    { value: 'regex', label: '正则匹配' },
                  ]}
                />
              </FormField>
              <FormField label='匹配内容' hint='例如 /help、退款、^订单\\s+\\d+$ 。全部匹配时可留空。' full>
                <input
                  placeholder='例如：ping、/help、退款'
                  value={ruleDraft.match.pattern}
                  onChange={(e) => setRuleDraft((draft) => ({ ...draft, match: { ...draft.match, pattern: e.target.value } }))}
                />
              </FormField>
              <FormField label='规则说明' full>
                <textarea value={ruleDraft.description} onChange={(e) => setRuleDraft((draft) => ({ ...draft, description: e.target.value }))} />
              </FormField>
            </div>
          ) : null}

          {ruleStep === 2 ? (
            <div className='dialog-stack'>
              <div className='dialog-grid'>
                <FormField label='请求方法'>
                  <SelectControl
                    value={ruleDraft.target.method}
                    onChange={(value) => setRuleDraft((draft) => ({ ...draft, target: { ...draft.target, method: value } }))}
                    options={[
                      { value: 'GET', label: 'GET' },
                      { value: 'POST', label: 'POST' },
                      { value: 'PUT', label: 'PUT' },
                      { value: 'PATCH', label: 'PATCH' },
                      { value: 'DELETE', label: 'DELETE' },
                    ]}
                  />
                </FormField>
                <FormField label='超时时间（毫秒）' hint='例如 5000、10000、30000。太长会拖慢微信回复。'>
                  <input
                    type='number'
                    value={ruleDraft.target.timeout_ms}
                    onChange={(e) => setRuleDraft((draft) => ({ ...draft, target: { ...draft.target, timeout_ms: Number(e.target.value) } }))}
                  />
                </FormField>
                <FormField label='接口地址模板' hint='OpenAI 兼容示例：https://api.openai.com/v1/chat/completions' full>
                  <input
                    placeholder='OpenAI 兼容示例：https://api.openai.com/v1/chat/completions'
                    value={ruleDraft.target.url_template}
                    onChange={(e) => setRuleDraft((draft) => ({ ...draft, target: { ...draft.target, url_template: e.target.value } }))}
                  />
                </FormField>
                <FormField label='跳过 TLS 校验' hint='仅自签名证书调试场景使用，正式环境尽量保持否。'>
                  <SelectControl
                    value={String(ruleDraft.target.insecure_skip_tls)}
                    onChange={(value) =>
                      setRuleDraft((draft) => ({ ...draft, target: { ...draft.target, insecure_skip_tls: value === 'true' } }))
                    }
                    options={[
                      { value: 'false', label: '否' },
                      { value: 'true', label: '是' },
                    ]}
                  />
                </FormField>
              </div>

              <div className='tab-card'>
                <div className='tab-bar'>
                  {[
                    { id: 'headers', label: '请求头 JSON' },
                    { id: 'query', label: '查询参数 JSON' },
                    { id: 'body', label: '请求体模板' },
                    { id: 'response', label: '回复模板' },
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      className={`tab-pill ${ruleEditorTab === tab.id ? 'active' : ''}`}
                      onClick={() => setRuleEditorTab(tab.id as RuleEditorTab)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {ruleEditorTab === 'headers' ? (
                  <EditorBlock
                    title='请求头 JSON'
                    hint='OpenAI 兼容示例：{"Authorization":"Bearer 你的Key","Content-Type":"application/json"}'
                    language='json'
                    value={ruleJsonDrafts.headers}
                    onChange={(value) => setRuleJsonDrafts((draft) => ({ ...draft, headers: value }))}
                  />
                ) : null}
                {ruleEditorTab === 'query' ? (
                  <EditorBlock
                    title='查询参数 JSON'
                    hint='这里会拼接到 URL 后面的 ?a=1&b=2。OpenAI 标准接口通常留空。'
                    language='json'
                    value={ruleJsonDrafts.query}
                    onChange={(value) => setRuleJsonDrafts((draft) => ({ ...draft, query: value }))}
                  />
                ) : null}
                {ruleEditorTab === 'body' ? (
                  <EditorBlock
                    title='请求体模板'
                    hint='OpenAI 兼容示例：{"model":"Qwen3.5-27B-FP8","messages":[{"role":"user","content":"{{ .Message.text }}"}]}'
                    language='json'
                    value={ruleDraft.target.body_template}
                    onChange={(value) => setRuleDraft((draft) => ({ ...draft, target: { ...draft.target, body_template: value } }))}
                  />
                ) : null}
                {ruleEditorTab === 'response' ? (
                  <EditorBlock
                    title='回复模板'
                    hint='OpenAI 兼容示例：{{ index (index .Response.json "choices") 0 "message" "content" }}'
                    language='handlebars'
                    value={ruleDraft.response.template}
                    onChange={(value) => setRuleDraft((draft) => ({ ...draft, response: { ...draft.response, template: value } }))}
                  />
                ) : null}
              </div>
            </div>
          ) : null}

          {ruleStep === 3 ? (
            <div className='dialog-grid'>
              <FormField label='回复模板'>
                <textarea
                  className='mono-area'
                  value={ruleDraft.response.template}
                  onChange={(e) => setRuleDraft((draft) => ({ ...draft, response: { ...draft.response, template: e.target.value } }))}
                />
              </FormField>
            </div>
          ) : null}

          <div className='dialog-footer'>
            {ruleStep < 3 ? (
              <button className='btn btn-primary' onClick={() => setRuleStep((step) => (step + 1) as RuleStep)}>
                下一步
              </button>
            ) : (
              <button className='btn btn-primary' onClick={() => void saveRule()}>
                保存规则
              </button>
            )}
          </div>
        </DialogShell>
      ) : null}

      {configModalOpen ? (
        <DialogShell title={editingAccountId ? '编辑微信配置' : '新建微信配置'} onClose={() => setConfigModalOpen(false)} width='wide'>
          <StepStrip
            steps={[
              { id: 1, label: '接口参数' },
              { id: 2, label: '绑定规则' },
              { id: 3, label: '扫码绑定' },
            ]}
            current={configStep}
          />

          {configStep === 1 ? (
            <div className='dialog-grid'>
              <FormField label='微信接口地址' hint='默认一般为 https://ilinkai.weixin.qq.com，不要填成业务接口。'>
                <input value={configDraft.base_url} onChange={(e) => setConfigDraft((draft) => ({ ...draft, base_url: e.target.value }))} />
              </FormField>
              <FormField label='机器人类型'>
                <input value={configDraft.bot_type} onChange={(e) => setConfigDraft((draft) => ({ ...draft, bot_type: e.target.value }))} />
              </FormField>
              <FormField label='路由标签' hint='只有上游明确要求时才需要填写。' full>
                <input value={configDraft.route_tag} onChange={(e) => setConfigDraft((draft) => ({ ...draft, route_tag: e.target.value }))} />
              </FormField>
            </div>
          ) : null}

          {configStep === 2 ? (
            <div className='rule-picker'>
              {state.settings.rules.map((rule) => {
                const checked = configDraft.rule_ids.includes(rule.id)
                return (
                  <label key={rule.id} className={`picker-row ${checked ? 'checked' : ''}`}>
                    <div className='picker-copy'>
                      <strong>{rule.name}</strong>
                      <span>{rule.description || rule.id}</span>
                    </div>
                    <input type='checkbox' checked={checked} onChange={(e) => toggleConfigRule(rule.id, e.target.checked)} />
                  </label>
                )
              })}
            </div>
          ) : null}

          {configStep === 3 ? (
            <div className='dialog-stack'>
              <div className='qr-toolbar'>
                <button className='btn btn-secondary' onClick={() => void startConfigLogin()} disabled={loginLoading}>
                  {loginLoading ? <LoaderCircle size={15} className='spin' /> : <QrCode size={15} />}
                  {editingAccountId ? '重新扫码绑定' : '生成二维码'}
                </button>
                <HintText>
                  编辑已有配置时，重新扫码会覆盖当前记录，不会新增一条新的微信配置。
                </HintText>
              </div>

              <div className='qr-card'>
                {qrURL ? (
                  <img src={qrURL} alt='微信扫码二维码' className='qr-image' />
                ) : (
                  <div className='qr-empty'>
                    <QrCode size={26} />
                    <span>点击上方按钮生成二维码</span>
                  </div>
                )}
              </div>
            </div>
          ) : null}

          <div className='dialog-footer'>
            {configStep < 3 ? (
              <button className='btn btn-primary' onClick={() => setConfigStep((step) => (step + 1) as ConfigStep)}>
                下一步
              </button>
            ) : (
              <button className='btn btn-primary' onClick={() => void saveConfigBindings()} disabled={savingConfig}>
                {savingConfig ? <LoaderCircle size={15} className='spin' /> : null}
                保存配置
              </button>
            )}
          </div>
        </DialogShell>
      ) : null}

      <div className='toast-stack'>
        {toasts.map((item) => (
          <div key={item.id} className={`toast ${item.kind}`}>
            <span>{item.message}</span>
            <button onClick={() => setToasts((current) => current.filter((toast) => toast.id !== item.id))}>
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function PageHeader({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className='page-header'>
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action ? <div className='page-header-action'>{action}</div> : null}
    </div>
  )
}

function DialogShell({
  title,
  onClose,
  children,
  width = 'normal',
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  width?: 'normal' | 'wide'
}) {
  return (
    <div className='dialog-backdrop'>
      <section className={`dialog-shell ${width === 'wide' ? 'wide' : ''}`}>
        <div className='dialog-header'>
          <h2>{title}</h2>
          <button className='icon-btn' onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className='dialog-body'>{children}</div>
      </section>
    </div>
  )
}

function StepStrip({
  steps,
  current,
}: {
  steps: Array<{ id: number; label: string }>
  current: number
}) {
  return (
    <div className='step-strip'>
      {steps.map((step) => (
        <div key={step.id} className={`step-chip ${current === step.id ? 'active' : ''}`}>
          <span>{step.id}</span>
          <strong>{step.label}</strong>
        </div>
      ))}
    </div>
  )
}

function FormField({
  label,
  hint,
  full,
  children,
}: {
  label: string
  hint?: string
  full?: boolean
  children: React.ReactNode
}) {
  return (
    <label className={`form-field ${full ? 'full' : ''}`}>
      <div className='field-top'>
        <span>{label}</span>
        {hint ? <HintText>{hint}</HintText> : null}
      </div>
      {children}
    </label>
  )
}

function HintText({ children }: { children: React.ReactNode }) {
  return (
    <span className='hint-inline' tabIndex={0}>
      <CircleHelp size={14} />
      <span className='hint-popover-inline'>{children}</span>
    </span>
  )
}

function SelectControl({
  value,
  options,
  onChange,
}: {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef<HTMLDivElement | null>(null)
  const selected = options.find((option) => option.value === value)

  React.useEffect(() => {
    if (!open) return
    const handler = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className='select-wrap' ref={ref}>
      <button type='button' className='select-trigger' onClick={() => setOpen((current) => !current)}>
        <span>{selected?.label || '请选择'}</span>
        <ChevronDown size={15} />
      </button>
      {open ? (
        <div className='select-menu'>
          {options.map((option) => (
            <button
              key={option.value}
              type='button'
              className={`select-option ${option.value === value ? 'active' : ''}`}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function EditorBlock({
  title,
  hint,
  language,
  value,
  onChange,
}: {
  title: string
  hint: string
  language: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <div className='editor-block'>
      <div className='editor-title'>
        <strong>{title}</strong>
        <span>{hint}</span>
      </div>
      <CodeEditor value={value} language={language} onChange={onChange} />
    </div>
  )
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
        value={value}
        language={language}
        height='188px'
        onChange={(next) => onChange(next ?? '')}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          lineNumbers: 'on',
          scrollBeyondLastLine: false,
          automaticLayout: true,
          wordWrap: 'on',
          padding: { top: 12, bottom: 12 },
        }}
        theme='vs'
      />
    </div>
  )
}

function StatusChip({ live, children }: { live: boolean; children: React.ReactNode }) {
  return <span className={`status-chip ${live ? 'live' : ''}`}>{children}</span>
}

function PreviewCard({
  title,
  children,
  wide,
}: {
  title: string
  children: React.ReactNode
  wide?: boolean
}) {
  return (
    <div className={`preview-card ${wide ? 'wide' : ''}`}>
      <strong>{title}</strong>
      {children}
    </div>
  )
}

function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className='info-card'>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  )
}

function IconActionButton({
  label,
  tone = 'default',
  onClick,
  children,
}: {
  label: string
  tone?: 'default' | 'primary' | 'success' | 'danger'
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button className={`icon-action ${tone}`} onClick={onClick} aria-label={label} title={label}>
      {children}
      <span className='icon-action-tooltip'>{label}</span>
    </button>
  )
}

function EmptyBlock({ title, text }: { title: string; text: string }) {
  return (
    <div className='empty-block'>
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  )
}

function matchModeLabel(mode: string) {
  switch (mode) {
    case 'all':
      return '全部匹配'
    case 'prefix':
      return '前缀匹配'
    case 'contains':
      return '包含匹配'
    case 'exact':
      return '完全匹配'
    case 'regex':
      return '正则匹配'
    default:
      return mode
  }
}

function formatTime(value?: string) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

async function apiJSON<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)
  const text = await response.text()
  const data = text ? JSON.parse(text) : {}
  if (!response.ok) {
    throw new Error(data.error || response.statusText)
  }
  return data as T
}

function getErrorMessage(error: unknown, fallback = '操作失败') {
  if (error instanceof Error) return error.message || fallback
  return fallback
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
