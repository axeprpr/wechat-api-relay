package relay

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"text/template"
	"time"

	"wechat-api-relay/internal/store"
)

type Engine struct {
	store    *store.Store
	settings func() (store.Settings, error)
}

type MessageContext struct {
	AccountID    string
	AccountRawID string
	AccountUser  string
	FromUserID   string
	Text         string
	ContextToken string
}

type templatePayload struct {
	Message  map[string]any `json:"message"`
	Account  map[string]any `json:"account"`
	Now      map[string]any `json:"now"`
	Request  map[string]any `json:"request,omitempty"`
	Response map[string]any `json:"response,omitempty"`
}

func NewEngine(st *store.Store, settings func() (store.Settings, error)) *Engine {
	return &Engine{store: st, settings: settings}
}

func (e *Engine) Reply(ctx context.Context, msg MessageContext) (string, string, error) {
	settings, err := e.settings()
	if err != nil {
		return "", "", fmt.Errorf("load settings: %w", err)
	}

	rule, err := selectRule(settings.EnabledRulesForAccount(msg.AccountID), msg.Text)
	if err != nil {
		return "", "", err
	}

	reqData := buildBaseTemplatePayload(msg)
	requestURL, err := renderTemplate(rule.Target.URLTemplate, reqData)
	if err != nil {
		return "", rule.ID, fmt.Errorf("render url: %w", err)
	}
	bodyText, err := renderTemplate(rule.Target.BodyTemplate, reqData)
	if err != nil {
		return "", rule.ID, fmt.Errorf("render body: %w", err)
	}
	headers, err := renderStringMap(rule.Target.Headers, reqData)
	if err != nil {
		return "", rule.ID, fmt.Errorf("render headers: %w", err)
	}
	query, err := renderStringMap(rule.Target.Query, reqData)
	if err != nil {
		return "", rule.ID, fmt.Errorf("render query: %w", err)
	}

	method := strings.ToUpper(strings.TrimSpace(rule.Target.Method))
	if method == "" {
		method = http.MethodPost
	}

	finalURL, err := withQuery(requestURL, query)
	if err != nil {
		return "", rule.ID, fmt.Errorf("build query: %w", err)
	}

	timeout := time.Duration(rule.Target.TimeoutMS) * time.Millisecond
	if timeout <= 0 {
		timeout = 60 * time.Second
	}

	client := &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: rule.Target.InsecureSkipTLS}, //nolint:gosec
		},
	}

	req, err := http.NewRequestWithContext(ctx, method, finalURL, strings.NewReader(bodyText))
	if err != nil {
		return "", rule.ID, err
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	if bodyText != "" && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := client.Do(req)
	if err != nil {
		return "", rule.ID, err
	}
	defer resp.Body.Close()

	rawBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", rule.ID, err
	}

	respData := buildResponseTemplatePayload(reqData, finalURL, bodyText, resp, rawBody)
	reply, err := renderTemplate(rule.Response.Template, respData)
	if err != nil {
		return "", rule.ID, fmt.Errorf("render response template: %w", err)
	}
	reply = strings.TrimSpace(reply)
	if reply == "" {
		reply = strings.TrimSpace(string(rawBody))
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return reply, rule.ID, fmt.Errorf("upstream http %d", resp.StatusCode)
	}

	if rule.Conversation.SaveHistory {
		history, loadErr := e.store.LoadConversation(msg.AccountID, msg.FromUserID)
		if loadErr == nil {
			history = append(history,
				store.Message{Role: "user", Content: msg.Text},
				store.Message{Role: "assistant", Content: reply},
			)
			history = trimConversation(history, max(1, rule.Conversation.HistoryLimit))
			_ = e.store.SaveConversation(msg.AccountID, msg.FromUserID, history)
		}
	}

	return reply, rule.ID, nil
}

func selectRule(rules []store.Rule, text string) (store.Rule, error) {
	for _, rule := range rules {
		if !rule.Enabled {
			continue
		}
		if matchRule(rule.Match, text) {
			return rule, nil
		}
	}
	return store.Rule{}, fmt.Errorf("no enabled rule matched message")
}

func matchRule(match store.MatchConfig, text string) bool {
	mode := strings.TrimSpace(match.Mode)
	switch mode {
	case "", "all":
		return true
	case "prefix":
		return strings.HasPrefix(text, match.Pattern)
	case "contains":
		return strings.Contains(text, match.Pattern)
	case "exact":
		return text == match.Pattern
	case "regex":
		re, err := regexp.Compile(match.Pattern)
		if err != nil {
			return false
		}
		return re.MatchString(text)
	default:
		return false
	}
}

func buildBaseTemplatePayload(msg MessageContext) templatePayload {
	return templatePayload{
		Message: map[string]any{
			"text":          msg.Text,
			"from":          msg.FromUserID,
			"context_token": msg.ContextToken,
		},
		Account: map[string]any{
			"id":      msg.AccountID,
			"raw_id":  msg.AccountRawID,
			"user_id": msg.AccountUser,
		},
		Now: map[string]any{
			"rfc3339": time.Now().UTC().Format(time.RFC3339),
			"unix":    time.Now().Unix(),
		},
	}
}

func buildResponseTemplatePayload(base templatePayload, finalURL, requestBody string, resp *http.Response, body []byte) templatePayload {
	out := base
	out.Request = map[string]any{
		"url":  finalURL,
		"body": requestBody,
	}
	jsonBody := map[string]any{}
	if len(body) > 0 {
		_ = json.Unmarshal(body, &jsonBody)
	}
	headers := map[string]any{}
	for key, values := range resp.Header {
		headers[key] = strings.Join(values, ", ")
	}
	out.Response = map[string]any{
		"status_code": resp.StatusCode,
		"body":        string(body),
		"json":        jsonBody,
		"headers":     headers,
	}
	return out
}

func renderStringMap(input map[string]string, data templatePayload) (map[string]string, error) {
	out := make(map[string]string, len(input))
	for key, value := range input {
		rendered, err := renderTemplate(value, data)
		if err != nil {
			return nil, err
		}
		out[key] = rendered
	}
	return out, nil
}

func renderTemplate(tpl string, data templatePayload) (string, error) {
	if strings.TrimSpace(tpl) == "" {
		return "", nil
	}
	t, err := template.New("tpl").Option("missingkey=zero").Parse(tpl)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := t.Execute(&buf, data); err != nil {
		return "", err
	}
	return buf.String(), nil
}

func withQuery(raw string, query map[string]string) (string, error) {
	if len(query) == 0 {
		return raw, nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	q := u.Query()
	for key, value := range query {
		q.Set(key, value)
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func trimConversation(msgs []store.Message, historyLimit int) []store.Message {
	maxMessages := historyLimit * 2
	if len(msgs) <= maxMessages {
		return msgs
	}
	return append([]store.Message(nil), msgs[len(msgs)-maxMessages:]...)
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
