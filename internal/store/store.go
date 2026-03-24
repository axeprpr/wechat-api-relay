package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"wechat-api-relay/internal/config"
)

type Store struct {
	root string
	mu   sync.Mutex
}

type Account struct {
	ID        string    `json:"id"`
	RawID     string    `json:"raw_id"`
	UserID    string    `json:"user_id"`
	Token     string    `json:"token"`
	BaseURL   string    `json:"base_url"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	SavedAt   time.Time `json:"saved_at"`
	RouteTag  string    `json:"route_tag,omitempty"`
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type Settings struct {
	Weixin          config.WeixinConfig `json:"weixin"`
	ActiveAccountID string              `json:"active_account_id"`
	Rules           []Rule              `json:"rules"`
	AccountRules    map[string][]string `json:"account_rules"`
}

type Rule struct {
	ID           string             `json:"id"`
	Name         string             `json:"name"`
	Description  string             `json:"description"`
	Enabled      bool               `json:"enabled"`
	Match        MatchConfig        `json:"match"`
	Target       TargetConfig       `json:"target"`
	Response     ResponseConfig     `json:"response"`
	Conversation ConversationConfig `json:"conversation"`
}

type MatchConfig struct {
	Mode    string `json:"mode"`
	Pattern string `json:"pattern"`
}

type TargetConfig struct {
	Method          string            `json:"method"`
	URLTemplate     string            `json:"url_template"`
	Headers         map[string]string `json:"headers"`
	Query           map[string]string `json:"query"`
	BodyTemplate    string            `json:"body_template"`
	TimeoutMS       int               `json:"timeout_ms"`
	InsecureSkipTLS bool              `json:"insecure_skip_tls"`
}

type ResponseConfig struct {
	Template string `json:"template"`
}

type ConversationConfig struct {
	SaveHistory  bool `json:"save_history"`
	HistoryLimit int  `json:"history_limit"`
}

func New(root string) (*Store, error) {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	for _, dir := range []string{"accounts", "pollers", "conversations"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o700); err != nil {
			return nil, fmt.Errorf("create %s dir: %w", dir, err)
		}
	}
	return &Store{root: root}, nil
}

func (s *Store) LoadSettings(defaults config.Config) (Settings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	settings := Settings{
		Weixin:       defaults.Weixin,
		Rules:        defaultRules(defaults),
		AccountRules: map[string][]string{},
	}
	path := filepath.Join(s.root, "settings.json")
	if err := readJSON(path, &settings); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return settings, nil
		}
		return Settings{}, err
	}
	if settings.Weixin.BaseURL == "" {
		settings.Weixin.BaseURL = defaults.Weixin.BaseURL
	}
	if settings.Weixin.BotType == "" {
		settings.Weixin.BotType = defaults.Weixin.BotType
	}
	if settings.Weixin.PollTimeout <= 0 {
		settings.Weixin.PollTimeout = defaults.Weixin.PollTimeout
	}
	if settings.Weixin.UserAgent == "" {
		settings.Weixin.UserAgent = defaults.Weixin.UserAgent
	}
	if len(settings.Rules) == 0 {
		settings.Rules = defaultRules(defaults)
	}
	if settings.AccountRules == nil {
		settings.AccountRules = map[string][]string{}
	}
	return settings, nil
}

func (s *Store) SaveSettings(settings Settings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return writeJSON(filepath.Join(s.root, "settings.json"), settings)
}

func (s *Store) SaveAccount(account Account) (Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	account.ID = normalizeID(account.RawID)
	if account.ID == "" {
		return Account{}, errors.New("empty account id")
	}
	if account.Token == "" {
		return Account{}, errors.New("empty account token")
	}

	path := filepath.Join(s.root, "accounts", account.ID+".json")
	if existing, err := readAccountLocked(path); err == nil {
		account.CreatedAt = nonZeroTime(existing.CreatedAt, existing.SavedAt)
	}
	account.applyTimestamps()
	if err := writeJSON(path, account); err != nil {
		return Account{}, err
	}
	return account, nil
}

func (s *Store) SaveAccountAs(account Account, targetID string) (Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	account.ID = strings.TrimSpace(targetID)
	if account.ID == "" {
		return Account{}, errors.New("empty target account id")
	}
	if account.Token == "" {
		return Account{}, errors.New("empty account token")
	}

	path := filepath.Join(s.root, "accounts", account.ID+".json")
	if existing, err := readAccountLocked(path); err == nil {
		account.CreatedAt = nonZeroTime(existing.CreatedAt, existing.SavedAt)
	}
	account.applyTimestamps()
	if err := writeJSON(path, account); err != nil {
		return Account{}, err
	}
	return account, nil
}

func (s *Store) DeleteAccount(accountID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	accountID = strings.TrimSpace(accountID)
	if accountID == "" {
		return errors.New("empty account id")
	}
	if err := os.Remove(filepath.Join(s.root, "accounts", accountID+".json")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_ = os.Remove(filepath.Join(s.root, "pollers", accountID+".cursor"))
	return nil
}

func (s *Store) LoadAccount(requestedID string) (Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if strings.TrimSpace(requestedID) != "" {
		var account Account
		if err := readJSON(filepath.Join(s.root, "accounts", requestedID+".json"), &account); err != nil {
			return Account{}, fmt.Errorf("load account %s: %w", requestedID, err)
		}
		account = hydrateAccount(account)
		return account, nil
	}

	entries, err := os.ReadDir(filepath.Join(s.root, "accounts"))
	if err != nil {
		return Account{}, err
	}
	if len(entries) == 0 {
		return Account{}, errors.New("no saved account found; run login first")
	}

	type candidate struct {
		account Account
	}
	candidates := make([]candidate, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		var account Account
		if err := readJSON(filepath.Join(s.root, "accounts", entry.Name()), &account); err != nil {
			continue
		}
		account = hydrateAccount(account)
		candidates = append(candidates, candidate{account: account})
	}
	if len(candidates) == 0 {
		return Account{}, errors.New("no valid saved account found")
	}

	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].account.UpdatedAt.After(candidates[j].account.UpdatedAt)
	})
	return candidates[0].account, nil
}

func (s *Store) ListAccounts() ([]Account, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	entries, err := os.ReadDir(filepath.Join(s.root, "accounts"))
	if err != nil {
		return nil, err
	}
	accounts := make([]Account, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		var account Account
		if err := readJSON(filepath.Join(s.root, "accounts", entry.Name()), &account); err != nil {
			continue
		}
		account = hydrateAccount(account)
		accounts = append(accounts, account)
	}
	sort.Slice(accounts, func(i, j int) bool {
		return accounts[i].UpdatedAt.After(accounts[j].UpdatedAt)
	})
	return accounts, nil
}

func (s *Store) SaveCursor(accountID, cursor string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return os.WriteFile(filepath.Join(s.root, "pollers", accountID+".cursor"), []byte(cursor), 0o600)
}

func (s *Store) LoadCursor(accountID string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := os.ReadFile(filepath.Join(s.root, "pollers", accountID+".cursor"))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func (s *Store) LoadConversation(accountID, userID string) ([]Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	path := s.conversationPath(accountID, userID)
	var msgs []Message
	if err := readJSON(path, &msgs); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	return msgs, nil
}

func (s *Store) SaveConversation(accountID, userID string, msgs []Message) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return writeJSON(s.conversationPath(accountID, userID), msgs)
}

func (s *Store) conversationPath(accountID, userID string) string {
	return filepath.Join(s.root, "conversations", normalizeID(accountID)+"__"+normalizeID(userID)+".json")
}

func normalizeID(raw string) string {
	replacer := strings.NewReplacer("@", "-", ".", "-", "/", "-", "\\", "-", ":", "-", " ", "-")
	return replacer.Replace(strings.TrimSpace(raw))
}

func readJSON(path string, dst any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, dst)
}

func writeJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func defaultRules(defaults config.Config) []Rule {
	return []Rule{
		{
			ID:          "builtin-ping-pong",
			Name:        "内置 Ping Pong",
			Description: "收到 ping 时直接返回 pong，不请求外部接口。",
			Enabled:     true,
			Match: MatchConfig{
				Mode:    "exact",
				Pattern: "ping",
			},
			Target: TargetConfig{
				Method:      "GET",
				URLTemplate: "builtin://ping-pong",
				Headers:     map[string]string{},
				Query:       map[string]string{},
				TimeoutMS:   1000,
			},
			Response: ResponseConfig{
				Template: `{{ .Response.body }}`,
			},
			Conversation: ConversationConfig{
				SaveHistory:  false,
				HistoryLimit: 1,
			},
		},
		{
			ID:          "openai-compatible",
			Name:        "OpenAI 兼容大模型",
			Description: "把消息转发到 OpenAI 兼容的 chat completions 接口。",
			Enabled:     true,
			Match: MatchConfig{
				Mode: "all",
			},
			Target: TargetConfig{
				Method:      "POST",
				URLTemplate: strings.TrimRight(defaults.LLM.BaseURL, "/") + defaults.LLM.ChatPath,
				Headers: map[string]string{
					"Content-Type":  "application/json",
					"Authorization": "Bearer " + defaults.LLM.APIKey,
				},
				BodyTemplate: `{"model":"` + defaults.LLM.Model + `","messages":[{"role":"system","content":"` + escapeJSON(defaults.LLM.SystemPrompt) + `"},{"role":"user","content":"{{ .Message.text }}"}]}`,
				TimeoutMS:    int(defaults.LLM.Timeout / time.Millisecond),
			},
			Response: ResponseConfig{
				Template: `{{ index (index .Response.json "choices") 0 "message" "content" }}`,
			},
			Conversation: ConversationConfig{
				SaveHistory:  true,
				HistoryLimit: max(1, defaults.LLM.HistoryLimit),
			},
		},
	}
}

func (s Settings) EnabledRulesForAccount(accountID string) []Rule {
	if len(s.Rules) == 0 {
		return nil
	}
	boundIDs := s.AccountRules[accountID]
	if len(boundIDs) == 0 {
		var enabled []Rule
		for _, rule := range s.Rules {
			if rule.Enabled {
				enabled = append(enabled, rule)
			}
		}
		return enabled
	}
	allowed := make(map[string]struct{}, len(boundIDs))
	for _, id := range boundIDs {
		allowed[id] = struct{}{}
	}
	var out []Rule
	for _, rule := range s.Rules {
		if !rule.Enabled {
			continue
		}
		if _, ok := allowed[rule.ID]; ok {
			out = append(out, rule)
		}
	}
	return out
}

func escapeJSON(s string) string {
	b, _ := json.Marshal(s)
	if len(b) >= 2 {
		return string(b[1 : len(b)-1])
	}
	return s
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func readAccountLocked(path string) (Account, error) {
	var account Account
	if err := readJSON(path, &account); err != nil {
		return Account{}, err
	}
	return hydrateAccount(account), nil
}

func hydrateAccount(account Account) Account {
	account.CreatedAt = nonZeroTime(account.CreatedAt, account.SavedAt, account.UpdatedAt)
	account.UpdatedAt = nonZeroTime(account.UpdatedAt, account.SavedAt, account.CreatedAt)
	account.SavedAt = nonZeroTime(account.SavedAt, account.UpdatedAt, account.CreatedAt)
	return account
}

func (a *Account) applyTimestamps() {
	now := time.Now().UTC()
	if a.CreatedAt.IsZero() {
		a.CreatedAt = nonZeroTime(a.SavedAt, now)
	}
	a.UpdatedAt = now
	a.SavedAt = now
}

func nonZeroTime(values ...time.Time) time.Time {
	for _, value := range values {
		if !value.IsZero() {
			return value
		}
	}
	return time.Time{}
}
