package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	defaultWeixinBaseURL = "https://ilinkai.weixin.qq.com"
	defaultBotType       = "3"
	defaultLLMBaseURL    = "https://api.openai.com/v1"
	defaultChatPath      = "/chat/completions"
	defaultHistoryLimit  = 12
	defaultPollTimeout   = 35 * time.Second
)

type Config struct {
	DataDir string       `json:"data_dir"`
	Admin   AdminConfig  `json:"admin"`
	Weixin  WeixinConfig `json:"weixin"`
	LLM     LLMConfig    `json:"llm"`
}

type AdminConfig struct {
	ListenAddr string `json:"listen_addr"`
}

type WeixinConfig struct {
	BaseURL     string        `json:"base_url"`
	BotType     string        `json:"bot_type"`
	RouteTag    string        `json:"route_tag"`
	PollTimeout time.Duration `json:"poll_timeout"`
	UserAgent   string        `json:"user_agent"`
}

type LLMConfig struct {
	BaseURL      string        `json:"base_url"`
	ChatPath     string        `json:"chat_path"`
	APIKey       string        `json:"api_key"`
	Model        string        `json:"model"`
	SystemPrompt string        `json:"system_prompt"`
	HistoryLimit int           `json:"history_limit"`
	Timeout      time.Duration `json:"timeout"`
}

func Load() (Config, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Config{}, fmt.Errorf("resolve home dir: %w", err)
	}

	dataDir := strings.TrimSpace(os.Getenv("WECHAT_RELAY_DATA_DIR"))
	if dataDir == "" {
		dataDir = filepath.Join(home, ".wechat-api-relay")
	}

	llm := LLMConfig{
		BaseURL:      getenvDefault("LLM_BASE_URL", defaultLLMBaseURL),
		ChatPath:     getenvDefault("LLM_CHAT_PATH", defaultChatPath),
		APIKey:       strings.TrimSpace(os.Getenv("LLM_API_KEY")),
		Model:        strings.TrimSpace(os.Getenv("LLM_MODEL")),
		SystemPrompt: strings.TrimSpace(os.Getenv("LLM_SYSTEM_PROMPT")),
		HistoryLimit: getenvInt("LLM_HISTORY_LIMIT", defaultHistoryLimit),
		Timeout:      getenvDuration("LLM_TIMEOUT", 90*time.Second),
	}

	return Config{
		DataDir: dataDir,
		Admin: AdminConfig{
			ListenAddr: getenvDefault("WECHAT_RELAY_ADMIN_ADDR", ":8080"),
		},
		Weixin: WeixinConfig{
			BaseURL:     getenvDefault("WEIXIN_BASE_URL", defaultWeixinBaseURL),
			BotType:     getenvDefault("WEIXIN_BOT_TYPE", defaultBotType),
			RouteTag:    strings.TrimSpace(os.Getenv("WEIXIN_ROUTE_TAG")),
			PollTimeout: getenvDuration("WEIXIN_POLL_TIMEOUT", defaultPollTimeout),
			UserAgent:   "wechat-api-relay/0.1",
		},
		LLM: llm,
	}, nil
}

func (c Config) ValidateRelay() error {
	if strings.TrimSpace(c.LLM.APIKey) == "" {
		return errors.New("LLM_API_KEY is required")
	}
	if strings.TrimSpace(c.LLM.Model) == "" {
		return errors.New("LLM_MODEL is required")
	}
	return nil
}

func getenvDefault(key, fallback string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	return v
}

func getenvInt(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

func getenvDuration(key string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return fallback
	}
	return d
}
