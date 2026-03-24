package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"wechat-api-relay/internal/config"
	"wechat-api-relay/internal/relay"
	"wechat-api-relay/internal/store"
	"wechat-api-relay/internal/weixin"

	"rsc.io/qr"
)

type AdminServer struct {
	cfg    config.Config
	store  *store.Store
	mux    *http.ServeMux
	server *http.Server
	run    *RelayManager
}

type RelayRunner struct {
	cfg   config.Config
	store *store.Store

	mu        sync.Mutex
	cancel    context.CancelFunc
	running   bool
	accountID string
}

type accountRuntimeInfo struct {
	Running         bool   `json:"running"`
	LastInboundAt   string `json:"last_inbound_at,omitempty"`
	LastInboundText string `json:"last_inbound_text,omitempty"`
	LastReplyAt     string `json:"last_reply_at,omitempty"`
	LastReplyText   string `json:"last_reply_text,omitempty"`
	LastRuleID      string `json:"last_rule_id,omitempty"`
	LastErrorAt     string `json:"last_error_at,omitempty"`
	LastError       string `json:"last_error,omitempty"`
}

type runtimeState struct {
	Running           bool                          `json:"running"`
	AccountID         string                        `json:"account_id"`
	RunningAccountIDs []string                      `json:"running_account_ids"`
	AccountStatuses   map[string]accountRuntimeInfo `json:"account_statuses"`
}

type RelayManager struct {
	cfg     config.Config
	store   *store.Store
	mu      sync.Mutex
	runners map[string]*RelayRunner
	status  map[string]accountRuntimeInfo
}

func NewAdminServer(cfg config.Config, st *store.Store) *AdminServer {
	s := &AdminServer{
		cfg:   cfg,
		store: st,
		mux:   http.NewServeMux(),
		run: &RelayManager{
			cfg:     cfg,
			store:   st,
			runners: map[string]*RelayRunner{},
			status:  map[string]accountRuntimeInfo{},
		},
	}
	s.routes()
	s.server = &http.Server{
		Addr:              cfg.Admin.ListenAddr,
		Handler:           s.mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	return s
}

func (s *AdminServer) Run() error {
	log.Printf("admin ui listening on http://127.0.0.1%s", s.cfg.Admin.ListenAddr)
	return s.server.ListenAndServe()
}

func (s *AdminServer) routes() {
	s.mux.HandleFunc("/api/state", s.handleState)
	s.mux.HandleFunc("/api/settings", s.handleSettings)
	s.mux.HandleFunc("/api/accounts/delete", s.handleAccountDelete)
	s.mux.HandleFunc("/api/rules/preview", s.handleRulePreview)
	s.mux.HandleFunc("/api/runtime/start", s.handleRuntimeStart)
	s.mux.HandleFunc("/api/runtime/stop", s.handleRuntimeStop)
	s.mux.HandleFunc("/api/login/start", s.handleLoginStart)
	s.mux.HandleFunc("/api/login/status", s.handleLoginStatus)
	s.mux.HandleFunc("/api/login/qr", s.handleLoginQR)
	s.mux.Handle("/", s.serveApp())
}

func (s *AdminServer) handleState(w http.ResponseWriter, r *http.Request) {
	settings, accounts, rt, err := s.loadState()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"settings": settings,
		"accounts": accounts,
		"runtime":  rt,
	})
}

func (s *AdminServer) handleSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		settings, err := s.store.LoadSettings(s.cfg)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, settings)
	case http.MethodPut:
		var settings store.Settings
		if err := json.NewDecoder(r.Body).Decode(&settings); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		if settings.Weixin.BaseURL == "" {
			settings.Weixin.BaseURL = s.cfg.Weixin.BaseURL
		}
		if settings.Weixin.BotType == "" {
			settings.Weixin.BotType = s.cfg.Weixin.BotType
		}
		if settings.Weixin.UserAgent == "" {
			settings.Weixin.UserAgent = s.cfg.Weixin.UserAgent
		}
		if settings.Weixin.PollTimeout <= 0 {
			settings.Weixin.PollTimeout = s.cfg.Weixin.PollTimeout
		}
		if settings.AccountRules == nil {
			settings.AccountRules = map[string][]string{}
		}
		normalizeRules(&settings)
		if err := s.store.SaveSettings(settings); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, settings)
	default:
		writeError(w, http.StatusMethodNotAllowed, fmt.Errorf("method not allowed"))
	}
}

func (s *AdminServer) handleAccountDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, fmt.Errorf("method not allowed"))
		return
	}
	accountID := strings.TrimSpace(r.URL.Query().Get("account_id"))
	if accountID == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("missing account_id"))
		return
	}
	s.run.Stop(accountID)

	settings, err := s.store.LoadSettings(s.cfg)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	delete(settings.AccountRules, accountID)
	if settings.ActiveAccountID == accountID {
		settings.ActiveAccountID = ""
	}
	if err := s.store.SaveSettings(settings); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if err := s.store.DeleteAccount(accountID); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	settings, accounts, rt, err := s.loadState()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"settings": settings,
		"accounts": accounts,
		"runtime":  rt,
	})
}

type rulePreviewRequest struct {
	Rule      store.Rule `json:"rule"`
	AccountID string     `json:"account_id"`
	UserID    string     `json:"user_id"`
	Text      string     `json:"text"`
}

func (s *AdminServer) handleRulePreview(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, fmt.Errorf("method not allowed"))
		return
	}
	var req rulePreviewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	settings, err := s.store.LoadSettings(s.cfg)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if strings.TrimSpace(req.AccountID) == "" {
		req.AccountID = settings.ActiveAccountID
	}
	account, err := s.store.LoadAccount(req.AccountID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	engine := relay.NewEngine(s.store, func() (store.Settings, error) {
		return s.store.LoadSettings(s.cfg)
	})
	result, runErr := engine.ExecuteRule(r.Context(), req.Rule, relay.MessageContext{
		AccountID:    account.ID,
		AccountRawID: account.RawID,
		AccountUser:  account.UserID,
		FromUserID:   localFirstNonEmpty(strings.TrimSpace(req.UserID), "debug-user@im.wechat"),
		Text:         req.Text,
		ContextToken: "debug-context-token",
	})
	if runErr != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":     false,
			"result": result,
			"error":  runErr.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"result": result,
		"error":  "",
	})
}

func (s *AdminServer) handleLoginStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, fmt.Errorf("method not allowed"))
		return
	}
	settings, err := s.store.LoadSettings(s.cfg)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	client := weixin.NewClient(settings.Weixin)
	start, err := client.StartLogin(r.Context(), "")
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"session_key": start.QRCode,
		"qr_code_url": start.QRCodeURL,
	})
}

func (s *AdminServer) handleLoginStatus(w http.ResponseWriter, r *http.Request) {
	sessionKey := strings.TrimSpace(r.URL.Query().Get("session_key"))
	targetAccountID := strings.TrimSpace(r.URL.Query().Get("target_account_id"))
	if sessionKey == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("missing session_key"))
		return
	}
	settings, err := s.store.LoadSettings(s.cfg)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	client := weixin.NewClient(settings.Weixin)
	status, err := client.PollLoginStatus(r.Context(), sessionKey)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	resp := map[string]any{"status": status.Status}
	if status.Status == "confirmed" && status.BotToken != "" && status.AccountID != "" {
		wasRunning := false
		if targetAccountID != "" {
			for _, runningID := range s.run.State().RunningAccountIDs {
				if runningID == targetAccountID {
					wasRunning = true
					break
				}
			}
		}
		accountPayload := store.Account{
			RawID:    status.AccountID,
			UserID:   status.UserID,
			Token:    status.BotToken,
			BaseURL:  localFirstNonEmpty(status.BaseURL, settings.Weixin.BaseURL),
			RouteTag: settings.Weixin.RouteTag,
		}
		var (
			account store.Account
			err     error
		)
		if targetAccountID != "" {
			account, err = s.store.SaveAccountAs(accountPayload, targetAccountID)
		} else {
			account, err = s.store.SaveAccount(accountPayload)
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		settings.ActiveAccountID = account.ID
		if _, ok := settings.AccountRules[account.ID]; !ok {
			var allEnabled []string
			for _, rule := range settings.Rules {
				if rule.Enabled {
					allEnabled = append(allEnabled, rule.ID)
				}
			}
			settings.AccountRules[account.ID] = allEnabled
		}
		_ = s.store.SaveSettings(settings)
		if wasRunning {
			s.run.Stop(account.ID)
			time.Sleep(300 * time.Millisecond)
			if err := s.run.Start(account); err != nil {
				log.Printf("auto restart after rebind failed for %s: %v", account.ID, err)
			}
		}
		resp["account_id"] = account.ID
		resp["user_id"] = account.UserID
		resp["auto_restarted"] = wasRunning
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *AdminServer) handleLoginQR(w http.ResponseWriter, r *http.Request) {
	content := strings.TrimSpace(r.URL.Query().Get("content"))
	if content == "" {
		writeError(w, http.StatusBadRequest, fmt.Errorf("missing content"))
		return
	}
	code, err := qr.Encode(content, qr.M)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	code.Scale = 8
	w.Header().Set("Content-Type", "image/png")
	_, _ = w.Write(code.PNG())
}

func (s *AdminServer) handleRuntimeStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, fmt.Errorf("method not allowed"))
		return
	}
	accountID := strings.TrimSpace(r.URL.Query().Get("account_id"))
	if accountID == "" {
		settings, err := s.store.LoadSettings(s.cfg)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		accountID = settings.ActiveAccountID
	}
	account, err := s.store.LoadAccount(accountID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := s.run.Start(account); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusOK, s.run.State())
}

func (s *AdminServer) handleRuntimeStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, fmt.Errorf("method not allowed"))
		return
	}
	accountID := strings.TrimSpace(r.URL.Query().Get("account_id"))
	if accountID == "" {
		s.run.StopAll()
	} else {
		s.run.Stop(accountID)
	}
	writeJSON(w, http.StatusOK, s.run.State())
}

func (s *AdminServer) serveApp() http.Handler {
	distDir := resolveWebDistDir()
	if stat, err := os.Stat(distDir); err == nil && stat.IsDir() {
		fs := http.FileServer(http.Dir(distDir))
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				http.NotFound(w, r)
				return
			}
			path := filepath.Join(distDir, strings.TrimPrefix(filepath.Clean(r.URL.Path), "/"))
			if r.URL.Path == "/" {
				http.ServeFile(w, r, filepath.Join(distDir, "index.html"))
				return
			}
			if _, err := os.Stat(path); err == nil {
				fs.ServeHTTP(w, r)
				return
			}
			http.ServeFile(w, r, filepath.Join(distDir, "index.html"))
		})
	}
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(`<html><body style="font-family:sans-serif;padding:24px"><h1>wechat-api-relay</h1><p>Frontend assets not built yet. Run <code>npm install && npm run build</code> in <code>web/</code>, then refresh this page.</p></body></html>`))
	})
}

func resolveWebDistDir() string {
	if env := strings.TrimSpace(os.Getenv("WECHAT_RELAY_WEB_DIR")); env != "" {
		return env
	}
	candidates := []string{
		filepath.Join("web", "dist"),
		"/usr/share/wechat-api-relay/web/dist",
	}
	for _, candidate := range candidates {
		if stat, err := os.Stat(candidate); err == nil && stat.IsDir() {
			return candidate
		}
	}
	return filepath.Join("web", "dist")
}

func (s *AdminServer) loadState() (store.Settings, []store.Account, runtimeState, error) {
	settings, err := s.store.LoadSettings(s.cfg)
	if err != nil {
		return store.Settings{}, nil, runtimeState{}, err
	}
	accounts, err := s.store.ListAccounts()
	if err != nil {
		return store.Settings{}, nil, runtimeState{}, err
	}
	return settings, accounts, s.run.State(), nil
}

func (m *RelayManager) Start(account store.Account) error {
	m.mu.Lock()
	if runner, ok := m.runners[account.ID]; ok {
		m.mu.Unlock()
		if runner.IsRunning() {
			return fmt.Errorf("relay already running for %s", account.ID)
		}
	} else {
		m.runners[account.ID] = &RelayRunner{cfg: m.cfg, store: m.store}
		m.mu.Unlock()
	}
	m.mu.Lock()
	r := m.runners[account.ID]
	m.mu.Unlock()

	r.mu.Lock()
	defer r.mu.Unlock()
	if r.running {
		return fmt.Errorf("relay already running for %s", account.ID)
	}
	settingsLoader := func() (store.Settings, error) {
		return m.store.LoadSettings(m.cfg)
	}
	settings, err := settingsLoader()
	if err != nil {
		return err
	}
	hasEnabled := false
	for _, rule := range settings.Rules {
		if rule.Enabled {
			hasEnabled = true
			break
		}
	}
	if !hasEnabled {
		return fmt.Errorf("at least one enabled rule is required")
	}
	if bound := settings.AccountRules[account.ID]; len(bound) == 0 {
		return fmt.Errorf("no rules are bound to account %s", account.ID)
	}

	ctx, cancel := context.WithCancel(context.Background())
	engine := relay.NewEngine(m.store, settingsLoader)
	client := weixin.NewClient(settings.Weixin)
	poller := weixin.NewPoller(client, m.store, engine, m)

	r.cancel = cancel
	r.running = true
	r.accountID = account.ID

	go func() {
		defer func() {
			r.reset()
			m.setRunning(account.ID, false)
		}()
		if err := poller.Run(ctx, account); err != nil && err != context.Canceled {
			log.Printf("relay stopped with error: %v", err)
			m.OnError(account.ID, err.Error())
		}
	}()
	m.setRunning(account.ID, true)
	return nil
}

func (m *RelayManager) Stop(accountID string) {
	m.mu.Lock()
	runner := m.runners[accountID]
	m.mu.Unlock()
	if runner != nil {
		runner.Stop()
		m.setRunning(accountID, false)
	}
}

func (m *RelayManager) StopAll() {
	m.mu.Lock()
	runners := make([]*RelayRunner, 0, len(m.runners))
	for _, runner := range m.runners {
		runners = append(runners, runner)
	}
	m.mu.Unlock()
	for _, runner := range runners {
		runner.Stop()
	}
}

func (r *RelayRunner) Stop() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cancel != nil {
		r.cancel()
	}
	r.running = false
}

func (m *RelayManager) State() runtimeState {
	m.mu.Lock()
	defer m.mu.Unlock()
	runningIDs := make([]string, 0, len(m.runners))
	for accountID, runner := range m.runners {
		if runner.IsRunning() {
			runningIDs = append(runningIDs, accountID)
		}
	}
	state := runtimeState{RunningAccountIDs: runningIDs}
	if len(runningIDs) > 0 {
		state.Running = true
		state.AccountID = runningIDs[0]
	}
	state.AccountStatuses = make(map[string]accountRuntimeInfo, len(m.status))
	for accountID, info := range m.status {
		state.AccountStatuses[accountID] = info
	}
	return state
}

func (m *RelayManager) OnInbound(accountID, _ string, text string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	info := m.status[accountID]
	info.LastInboundAt = time.Now().UTC().Format(time.RFC3339)
	info.LastInboundText = text
	m.status[accountID] = info
}

func (m *RelayManager) OnReply(accountID, _ string, ruleID, text string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	info := m.status[accountID]
	info.LastReplyAt = time.Now().UTC().Format(time.RFC3339)
	info.LastReplyText = text
	info.LastRuleID = ruleID
	m.status[accountID] = info
}

func (m *RelayManager) OnError(accountID, message string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	info := m.status[accountID]
	info.LastErrorAt = time.Now().UTC().Format(time.RFC3339)
	info.LastError = message
	m.status[accountID] = info
}

func (m *RelayManager) setRunning(accountID string, running bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	info := m.status[accountID]
	info.Running = running
	m.status[accountID] = info
}

func (r *RelayRunner) IsRunning() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.running
}

func (r *RelayRunner) reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.running = false
	r.accountID = ""
	r.cancel = nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]any{
		"error": err.Error(),
	})
}

func localFirstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func normalizeRules(settings *store.Settings) {
	for i := range settings.Rules {
		rule := &settings.Rules[i]
		if strings.TrimSpace(rule.ID) == "" {
			rule.ID = fmt.Sprintf("rule-%d", i+1)
		}
		if strings.TrimSpace(rule.Name) == "" {
			rule.Name = rule.ID
		}
		if rule.Target.TimeoutMS <= 0 {
			rule.Target.TimeoutMS = 60000
		}
		if rule.Match.Mode == "" {
			rule.Match.Mode = "all"
		}
		if rule.Target.Headers == nil {
			rule.Target.Headers = map[string]string{}
		}
		if rule.Target.Query == nil {
			rule.Target.Query = map[string]string{}
		}
		if rule.Response.Template == "" {
			rule.Response.Template = `{{ .Response.body }}`
		}
		if rule.Conversation.HistoryLimit <= 0 {
			rule.Conversation.HistoryLimit = 12
		}
	}
}
