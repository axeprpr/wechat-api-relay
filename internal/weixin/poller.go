package weixin

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"wechat-api-relay/internal/relay"
	"wechat-api-relay/internal/store"
)

type Replier interface {
	Reply(ctx context.Context, msg relay.MessageContext) (string, string, error)
}

type Poller struct {
	client  *Client
	store   *store.Store
	replier Replier
}

func NewPoller(client *Client, st *store.Store, replier Replier) *Poller {
	return &Poller{
		client:  client,
		store:   st,
		replier: replier,
	}
}

func (p *Poller) Run(ctx context.Context, account store.Account) error {
	cursor, err := p.store.LoadCursor(account.ID)
	if err != nil {
		return err
	}

	nextTimeout := p.client.cfg.PollTimeout
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		resp, err := p.client.GetUpdates(ctx, account, cursor, nextTimeout)
		if err != nil {
			log.Printf("poll error: %v", err)
			time.Sleep(2 * time.Second)
			continue
		}
		if resp.GetUpdatesBuf != "" && resp.GetUpdatesBuf != cursor {
			cursor = resp.GetUpdatesBuf
			if err := p.store.SaveCursor(account.ID, cursor); err != nil {
				log.Printf("save cursor error: %v", err)
			}
		}
		if resp.LongPollingTimeoutMS > 0 {
			nextTimeout = time.Duration(resp.LongPollingTimeoutMS) * time.Millisecond
		}
		if resp.Ret != 0 || resp.ErrCode != 0 {
			log.Printf("getupdates returned ret=%d errcode=%d errmsg=%s", resp.Ret, resp.ErrCode, resp.ErrMsg)
			time.Sleep(2 * time.Second)
			continue
		}

		for _, msg := range resp.Messages {
			if err := p.handleMessage(ctx, account, msg); err != nil {
				log.Printf("handle message error: %v", err)
			}
		}
	}
}

func (p *Poller) handleMessage(ctx context.Context, account store.Account, msg WeixinMessage) error {
	if strings.TrimSpace(msg.FromUserID) == "" {
		return nil
	}

	text := extractText(msg)
	if text == "" {
		log.Printf("skip non-text message from %s", msg.FromUserID)
		return nil
	}
	if strings.TrimSpace(msg.ContextToken) == "" {
		return fmt.Errorf("missing context token for message from %s", msg.FromUserID)
	}

	log.Printf("inbound from=%s text=%q", msg.FromUserID, shorten(text, 120))
	reply, ruleID, err := p.replier.Reply(ctx, relay.MessageContext{
		AccountID:    account.ID,
		AccountRawID: account.RawID,
		AccountUser:  account.UserID,
		FromUserID:   msg.FromUserID,
		Text:         text,
		ContextToken: msg.ContextToken,
	})
	if err != nil {
		if strings.TrimSpace(reply) == "" {
			reply = "上游接口调用失败，请稍后再试。"
		}
		log.Printf("relay error for %s via rule=%s: %v", msg.FromUserID, ruleID, err)
	}

	if err := p.client.SendText(ctx, account, msg.FromUserID, msg.ContextToken, reply); err != nil {
		return fmt.Errorf("send reply: %w", err)
	}
	log.Printf("replied to=%s via rule=%s text=%q", msg.FromUserID, ruleID, shorten(reply, 120))
	return nil
}

func extractText(msg WeixinMessage) string {
	for _, item := range msg.ItemList {
		if item.TextItem != nil && strings.TrimSpace(item.TextItem.Text) != "" {
			return strings.TrimSpace(item.TextItem.Text)
		}
		if item.VoiceItem != nil && strings.TrimSpace(item.VoiceItem.Text) != "" {
			return strings.TrimSpace(item.VoiceItem.Text)
		}
	}
	return ""
}

func shorten(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}
