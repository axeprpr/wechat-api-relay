import React from 'react'
import ReactDOM from 'react-dom/client'
import {
  Bot,
  Cable,
  CirclePlay,
  CircleStop,
  Plus,
  QrCode,
  Save,
  Send,
  Settings2,
  Trash2,
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

type AppState = {
  settings: Settings
  accounts: Account[]
  runtime: RuntimeState
}

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
    body_template: '{"text":"{{ .Message.text }}","from":"{{ .Message.from }}"}',
    timeout_ms: 60000,
    insecure_skip_tls: false,
  },
  response: { template: '{{ .Response.body }}' },
  conversation: { save_history: false, history_limit: 12 },
})

function App() {
  const [state, setState] = React.useState<AppState | null>(null)
  const [selectedRuleId, setSelectedRuleId] = React.useState<string>('')
  const [saving, setSaving] = React.useState(false)
  const [message, setMessage] = React.useState<string>('')
  const [qrURL, setQrURL] = React.useState<string>('')
  const [loginSession, setLoginSession] = React.useState<string>('')

  const loadState = React.useCallback(async () => {
    const resp = await fetch('/api/state')
    const data = (await resp.json()) as AppState
    setState(data)
    if (!selectedRuleId && data.settings.rules.length > 0) {
      setSelectedRuleId(data.settings.rules[0].id)
    }
  }, [selectedRuleId])

  React.useEffect(() => {
    void loadState()
  }, [loadState])

  React.useEffect(() => {
    if (!loginSession) return
    const timer = window.setInterval(async () => {
      const resp = await fetch(`/api/login/status?session_key=${encodeURIComponent(loginSession)}`)
      const data = await resp.json()
      setMessage(`登录状态: ${JSON.stringify(data)}`)
      if (data.status === 'confirmed') {
        window.clearInterval(timer)
        setLoginSession('')
        setQrURL('')
        await loadState()
      }
    }, 2500)
    return () => window.clearInterval(timer)
  }, [loginSession, loadState])

  if (!state) {
    return <div className="loading">Loading…</div>
  }

  const selectedRule = state.settings.rules.find((rule) => rule.id === selectedRuleId) ?? state.settings.rules[0]

  const updateSettings = (next: Settings) => {
    setState({ ...state, settings: next })
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
      setMessage('配置已保存')
    } finally {
      setSaving(false)
    }
  }

  const startLogin = async () => {
    const resp = await fetch('/api/login/start', { method: 'POST' })
    const data = await resp.json()
    setQrURL(`/api/login/qr?content=${encodeURIComponent(data.qr_code_url)}`)
    setLoginSession(data.session_key)
    setMessage('请使用微信扫码登录')
  }

  const startRuntime = async () => {
    await fetch('/api/runtime/start', { method: 'POST' })
    await loadState()
    setMessage('中继已启动')
  }

  const stopRuntime = async () => {
    await fetch('/api/runtime/stop', { method: 'POST' })
    await loadState()
    setMessage('中继已停止')
  }

  const updateRule = (patch: Partial<Rule>) => {
    const rules = state.settings.rules.map((rule) =>
      rule.id === selectedRule.id ? { ...rule, ...patch } : rule
    )
    updateSettings({ ...state.settings, rules })
  }

  const updateRuleNested = <K extends keyof Rule>(key: K, value: Rule[K]) => {
    updateRule({ [key]: value } as Partial<Rule>)
  }

  const addRule = () => {
    const rule = emptyRule()
    updateSettings({ ...state.settings, rules: [...state.settings.rules, rule] })
    setSelectedRuleId(rule.id)
  }

  const removeRule = (ruleID: string) => {
    const rules = state.settings.rules.filter((rule) => rule.id !== ruleID)
    updateSettings({ ...state.settings, rules })
    if (selectedRuleId === ruleID && rules.length > 0) {
      setSelectedRuleId(rules[0].id)
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-badge">
            <Bot size={18} />
          </div>
          <div>
            <strong>wechat-api-relay</strong>
            <p>Adapted from shadcn-admin shell</p>
          </div>
        </div>

        <nav className="nav">
          <button className="nav-item active">
            <Cable size={16} /> Relay Console
          </button>
          <button className="nav-item" onClick={addRule}>
            <Plus size={16} /> New Rule
          </button>
        </nav>

        <div className="runtime-card">
          <span className={`pill ${state.runtime.running ? 'live' : ''}`}>
            {state.runtime.running ? 'Running' : 'Stopped'}
          </span>
          <p>{state.runtime.account_id || 'No active account'}</p>
          <div className="runtime-actions">
            <button onClick={startRuntime}><CirclePlay size={16} /> Start</button>
            <button className="ghost" onClick={stopRuntime}><CircleStop size={16} /> Stop</button>
          </div>
        </div>
      </aside>

      <main className="content">
        <header className="hero">
          <div>
            <p className="eyebrow">WeChat to Any HTTP API</p>
            <h1>把微信消息路由到任意 API</h1>
            <p className="hero-copy">
              配置微信接入、扫码绑定账号、编排任意 HTTP 规则，并把响应回发到微信。
            </p>
          </div>
          <button className="primary" onClick={saveSettings} disabled={saving}>
            <Save size={16} /> {saving ? 'Saving…' : 'Save All'}
          </button>
        </header>

        <section className="dashboard-grid">
          <article className="panel">
            <div className="panel-header">
              <div>
                <h2><Settings2 size={18} /> 微信通道</h2>
                <p>扫码登录、切换活动账号、调整长轮询网关参数。</p>
              </div>
              <button className="outline" onClick={startLogin}>
                <QrCode size={16} /> Start Login
              </button>
            </div>

            <div className="form-grid">
              <Field label="Weixin Base URL">
                <input
                  value={state.settings.weixin.base_url}
                  onChange={(e) =>
                    updateSettings({
                      ...state.settings,
                      weixin: { ...state.settings.weixin, base_url: e.target.value },
                    })
                  }
                />
              </Field>
              <Field label="Bot Type">
                <input
                  value={state.settings.weixin.bot_type}
                  onChange={(e) =>
                    updateSettings({
                      ...state.settings,
                      weixin: { ...state.settings.weixin, bot_type: e.target.value },
                    })
                  }
                />
              </Field>
              <Field label="Route Tag">
                <input
                  value={state.settings.weixin.route_tag}
                  onChange={(e) =>
                    updateSettings({
                      ...state.settings,
                      weixin: { ...state.settings.weixin, route_tag: e.target.value },
                    })
                  }
                />
              </Field>
              <Field label="Active Account">
                <select
                  value={state.settings.active_account_id}
                  onChange={(e) =>
                    updateSettings({ ...state.settings, active_account_id: e.target.value })
                  }
                >
                  <option value="">Select account</option>
                  {state.accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.id} / {account.user_id}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {qrURL && (
              <div className="qr-box">
                <img src={qrURL} alt="WeChat login QR" />
              </div>
            )}
          </article>

          <article className="panel rule-list">
            <div className="panel-header">
              <div>
                <h2><Send size={18} /> 转发规则</h2>
                <p>按顺序匹配消息，命中第一条启用规则后转发。</p>
              </div>
            </div>
            <div className="rule-items">
              {state.settings.rules.map((rule) => (
                <button
                  key={rule.id}
                  className={`rule-item ${selectedRule?.id === rule.id ? 'selected' : ''}`}
                  onClick={() => setSelectedRuleId(rule.id)}
                >
                  <div>
                    <strong>{rule.name}</strong>
                    <span>{rule.match.mode} / {rule.match.pattern || '*'}</span>
                  </div>
                  <span className={`pill ${rule.enabled ? 'live' : ''}`}>
                    {rule.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </button>
              ))}
            </div>
          </article>
        </section>

        {selectedRule && (
          <section className="editor-grid">
            <article className="panel">
              <div className="panel-header">
                <div>
                  <h2>规则编辑</h2>
                  <p>用模板把微信消息映射成任意 HTTP 请求。</p>
                </div>
                <button className="ghost danger" onClick={() => removeRule(selectedRule.id)}>
                  <Trash2 size={16} /> Delete
                </button>
              </div>

              <div className="form-grid">
                <Field label="Rule ID">
                  <input
                    value={selectedRule.id}
                    onChange={(e) => updateRule({ id: e.target.value })}
                  />
                </Field>
                <Field label="Rule Name">
                  <input
                    value={selectedRule.name}
                    onChange={(e) => updateRule({ name: e.target.value })}
                  />
                </Field>
                <Field label="Description" full>
                  <textarea
                    value={selectedRule.description}
                    onChange={(e) => updateRule({ description: e.target.value })}
                  />
                </Field>
                <Field label="Enabled">
                  <select
                    value={String(selectedRule.enabled)}
                    onChange={(e) => updateRule({ enabled: e.target.value === 'true' })}
                  >
                    <option value="true">Enabled</option>
                    <option value="false">Disabled</option>
                  </select>
                </Field>
                <Field label="Match Mode">
                  <select
                    value={selectedRule.match.mode}
                    onChange={(e) =>
                      updateRuleNested('match', { ...selectedRule.match, mode: e.target.value })
                    }
                  >
                    <option value="all">all</option>
                    <option value="prefix">prefix</option>
                    <option value="contains">contains</option>
                    <option value="exact">exact</option>
                    <option value="regex">regex</option>
                  </select>
                </Field>
                <Field label="Match Pattern" full>
                  <input
                    value={selectedRule.match.pattern}
                    onChange={(e) =>
                      updateRuleNested('match', { ...selectedRule.match, pattern: e.target.value })
                    }
                  />
                </Field>
                <Field label="Method">
                  <input
                    value={selectedRule.target.method}
                    onChange={(e) =>
                      updateRuleNested('target', { ...selectedRule.target, method: e.target.value })
                    }
                  />
                </Field>
                <Field label="Timeout (ms)">
                  <input
                    type="number"
                    value={selectedRule.target.timeout_ms}
                    onChange={(e) =>
                      updateRuleNested('target', {
                        ...selectedRule.target,
                        timeout_ms: Number(e.target.value),
                      })
                    }
                  />
                </Field>
                <Field label="URL Template" full>
                  <input
                    value={selectedRule.target.url_template}
                    onChange={(e) =>
                      updateRuleNested('target', {
                        ...selectedRule.target,
                        url_template: e.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="Headers (JSON)" full>
                  <textarea
                    value={JSON.stringify(selectedRule.target.headers, null, 2)}
                    onChange={(e) =>
                      updateRuleNested('target', {
                        ...selectedRule.target,
                        headers: safeJSONMap(e.target.value),
                      })
                    }
                  />
                </Field>
                <Field label="Query (JSON)" full>
                  <textarea
                    value={JSON.stringify(selectedRule.target.query, null, 2)}
                    onChange={(e) =>
                      updateRuleNested('target', {
                        ...selectedRule.target,
                        query: safeJSONMap(e.target.value),
                      })
                    }
                  />
                </Field>
                <Field label="Body Template" full>
                  <textarea
                    value={selectedRule.target.body_template}
                    onChange={(e) =>
                      updateRuleNested('target', {
                        ...selectedRule.target,
                        body_template: e.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="Response Template" full>
                  <textarea
                    value={selectedRule.response.template}
                    onChange={(e) =>
                      updateRuleNested('response', {
                        ...selectedRule.response,
                        template: e.target.value,
                      })
                    }
                  />
                </Field>
              </div>
            </article>

            <article className="panel">
              <div className="panel-header">
                <div>
                  <h2>模板上下文</h2>
                  <p>可以在 URL、Header、Body、Response 模板中引用这些字段。</p>
                </div>
              </div>
              <pre className="code-block">{`{{ .Message.text }}
{{ .Message.from }}
{{ .Message.context_token }}
{{ .Account.id }}
{{ .Account.raw_id }}
{{ .Account.user_id }}
{{ .Now.rfc3339 }}

Response template can read:
{{ .Response.status_code }}
{{ .Response.body }}
{{ .Response.json }}
{{ .Response.headers }}`}</pre>
              <div className="status-box">{message || 'Ready.'}</div>
            </article>
          </section>
        )}
      </main>
    </div>
  )
}

function Field({
  label,
  full,
  children,
}: {
  label: string
  full?: boolean
  children: React.ReactNode
}) {
  return (
    <label className={full ? 'field full' : 'field'}>
      <span>{label}</span>
      {children}
    </label>
  )
}

function safeJSONMap(raw: string): Record<string, string> {
  try {
    return JSON.parse(raw) as Record<string, string>
  } catch {
    return {}
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
