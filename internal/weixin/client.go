package weixin

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"wechat-api-relay/internal/config"
	"wechat-api-relay/internal/store"
)

const channelVersion = "wechat-api-relay/0.1"

type Client struct {
	cfg    config.WeixinConfig
	client *http.Client
}

type LoginStart struct {
	SessionKey string
	QRCodeURL  string
	QRCode     string
}

type LoginResult struct {
	Account store.Account
}

func NewClient(cfg config.WeixinConfig) *Client {
	return &Client{
		cfg: cfg,
		client: &http.Client{
			Timeout: cfg.PollTimeout + 10*time.Second,
		},
	}
}

func (c *Client) StartLogin(ctx context.Context, requestedAccountID string) (LoginStart, error) {
	base := strings.TrimRight(c.cfg.BaseURL, "/")
	endpoint := fmt.Sprintf("%s/ilink/bot/get_bot_qrcode?bot_type=%s", base, url.QueryEscape(c.cfg.BotType))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return LoginStart{}, err
	}
	if c.cfg.RouteTag != "" {
		req.Header.Set("SKRouteTag", c.cfg.RouteTag)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return LoginStart{}, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return LoginStart{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return LoginStart{}, fmt.Errorf("login qr http %d: %s", resp.StatusCode, string(body))
	}

	var parsed QRCodeResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return LoginStart{}, err
	}

	sessionKey := strings.TrimSpace(requestedAccountID)
	if sessionKey == "" {
		sessionKey = parsed.QRCode
	}
	return LoginStart{
		SessionKey: sessionKey,
		QRCodeURL:  parsed.QRCodeImgURL,
		QRCode:     parsed.QRCode,
	}, nil
}

func (c *Client) WaitForLogin(ctx context.Context, sessionKey string) (LoginResult, error) {
	deadline := time.Now().Add(8 * time.Minute)
	for time.Now().Before(deadline) {
		parsed, err := c.PollLoginStatus(ctx, sessionKey)
		if err != nil {
			return LoginResult{}, err
		}
		switch parsed.Status {
		case "wait", "scaned":
			time.Sleep(2 * time.Second)
			continue
		case "confirmed":
			account := store.Account{
				RawID:    parsed.AccountID,
				UserID:   parsed.UserID,
				Token:    parsed.BotToken,
				BaseURL:  firstNonEmpty(parsed.BaseURL, c.cfg.BaseURL),
				RouteTag: c.cfg.RouteTag,
			}
			return LoginResult{Account: account}, nil
		case "expired":
			return LoginResult{}, fmt.Errorf("qr code expired; restart login")
		default:
			time.Sleep(2 * time.Second)
		}
	}
	return LoginResult{}, fmt.Errorf("login timeout")
}

func (c *Client) PollLoginStatus(ctx context.Context, sessionKey string) (QRStatusResponse, error) {
	base := strings.TrimRight(c.cfg.BaseURL, "/")
	statusURL := fmt.Sprintf("%s/ilink/bot/get_qrcode_status?qrcode=%s", base, url.QueryEscape(sessionKey))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, statusURL, nil)
	if err != nil {
		return QRStatusResponse{}, err
	}
	req.Header.Set("iLink-App-ClientVersion", "1")
	if c.cfg.RouteTag != "" {
		req.Header.Set("SKRouteTag", c.cfg.RouteTag)
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return QRStatusResponse{}, err
	}
	body, readErr := io.ReadAll(resp.Body)
	resp.Body.Close()
	if readErr != nil {
		return QRStatusResponse{}, readErr
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return QRStatusResponse{}, fmt.Errorf("login status http %d: %s", resp.StatusCode, string(body))
	}

	var parsed QRStatusResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return QRStatusResponse{}, err
	}
	return parsed, nil
}

func (c *Client) GetUpdates(ctx context.Context, account store.Account, cursor string, timeout time.Duration) (GetUpdatesResponse, error) {
	reqBody := GetUpdatesRequest{
		GetUpdatesBuf: cursor,
		BaseInfo:      BaseInfo{ChannelVersion: channelVersion},
	}
	var respBody GetUpdatesResponse
	if err := c.doJSON(ctx, account, http.MethodPost, "/ilink/bot/getupdates", reqBody, &respBody, timeout); err != nil {
		return GetUpdatesResponse{}, err
	}
	return respBody, nil
}

func (c *Client) SendText(ctx context.Context, account store.Account, toUserID, contextToken, text string) error {
	reqBody := SendMessageRequest{
		Msg: WeixinMessage{
			FromUserID:   "",
			ToUserID:     toUserID,
			ClientID:     randomClientID(),
			MessageType:  MessageTypeBot,
			MessageState: MessageStateFin,
			ContextToken: contextToken,
			ItemList: []MessageItem{
				{
					Type:     MessageTypeText,
					TextItem: &TextItem{Text: text},
				},
			},
		},
	}
	return c.doJSON(ctx, account, http.MethodPost, "/ilink/bot/sendmessage", reqBody, nil, 15*time.Second)
}

func (c *Client) GetConfig(ctx context.Context, account store.Account, ilinkUserID, contextToken string) (GetConfigResponse, error) {
	reqBody := GetConfigRequest{
		ILinkUserID:  ilinkUserID,
		ContextToken: contextToken,
		BaseInfo:     BaseInfo{ChannelVersion: channelVersion},
	}
	var respBody GetConfigResponse
	if err := c.doJSON(ctx, account, http.MethodPost, "/ilink/bot/getconfig", reqBody, &respBody, 10*time.Second); err != nil {
		return GetConfigResponse{}, err
	}
	return respBody, nil
}

func (c *Client) SendTyping(ctx context.Context, account store.Account, ilinkUserID, typingTicket string) error {
	if strings.TrimSpace(ilinkUserID) == "" || strings.TrimSpace(typingTicket) == "" {
		return nil
	}
	reqBody := SendTypingRequest{
		ILinkUserID:  ilinkUserID,
		TypingTicket: typingTicket,
		Status:       TypingStatusOn,
		BaseInfo:     BaseInfo{ChannelVersion: channelVersion},
	}
	return c.doJSON(ctx, account, http.MethodPost, "/ilink/bot/sendtyping", reqBody, nil, 10*time.Second)
}

func (c *Client) doJSON(ctx context.Context, account store.Account, method, endpoint string, payload any, out any, timeout time.Duration) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	base := strings.TrimRight(account.BaseURL, "/")
	req, err := http.NewRequestWithContext(ctx, method, base+endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("AuthorizationType", "ilink_bot_token")
	req.Header.Set("X-WECHAT-UIN", randomWechatUIN())
	req.Header.Set("Content-Length", fmt.Sprintf("%d", len(body)))
	req.Header.Set("User-Agent", c.cfg.UserAgent)
	if account.Token != "" {
		req.Header.Set("Authorization", "Bearer "+account.Token)
	}
	if account.RouteTag != "" {
		req.Header.Set("SKRouteTag", account.RouteTag)
	}

	client := *c.client
	client.Timeout = timeout
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("weixin http %d: %s", resp.StatusCode, string(raw))
	}
	if out == nil || len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, out)
}

func randomWechatUIN() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return base64.StdEncoding.EncodeToString([]byte("0"))
	}
	v := binary.BigEndian.Uint32(b[:])
	return base64.StdEncoding.EncodeToString([]byte(fmt.Sprintf("%d", v)))
}

func randomClientID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("wechat-api-relay-%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("wechat-api-relay-%x", b[:])
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
