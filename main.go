package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"wechat-api-relay/internal/config"
	"wechat-api-relay/internal/relay"
	"wechat-api-relay/internal/store"
	"wechat-api-relay/internal/weixin"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	switch os.Args[1] {
	case "login":
		if err := runLogin(os.Args[2:]); err != nil {
			log.Fatalf("login failed: %v", err)
		}
	case "run":
		if err := runRelay(os.Args[2:]); err != nil {
			log.Fatalf("run failed: %v", err)
		}
	case "serve":
		if err := runAdmin(os.Args[2:]); err != nil {
			log.Fatalf("serve failed: %v", err)
		}
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, "Usage: %s <login|run|serve> [flags]\n", os.Args[0])
}

func runLogin(args []string) error {
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	accountID := fs.String("account", "", "reuse an existing account id when refreshing credentials")
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}

	st, err := store.New(cfg.DataDir)
	if err != nil {
		return err
	}
	settings, err := st.LoadSettings(cfg)
	if err != nil {
		return err
	}
	client := weixin.NewClient(settings.Weixin)

	ctx := context.Background()
	start, err := client.StartLogin(ctx, *accountID)
	if err != nil {
		return err
	}

	fmt.Println("Scan this QR code in WeChat to authorize:")
	if err := weixin.PrintQRCode(start.QRCodeURL); err != nil {
		fmt.Printf("QR URL: %s\n", start.QRCodeURL)
	}

	fmt.Println("Waiting for confirmation...")
	loginResult, err := client.WaitForLogin(ctx, start.SessionKey)
	if err != nil {
		return err
	}

	savedAccount, err := st.SaveAccount(loginResult.Account)
	if err != nil {
		return err
	}

	fmt.Printf("Login successful.\nAccount ID: %s\nWeChat User: %s\n", savedAccount.ID, savedAccount.UserID)
	return nil
}

func runRelay(args []string) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	accountID := fs.String("account", "", "specific account id to run; default uses the most recent account")
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}

	st, err := store.New(cfg.DataDir)
	if err != nil {
		return err
	}
	settingsLoader := func() (store.Settings, error) {
		return st.LoadSettings(cfg)
	}
	settings, err := settingsLoader()
	if err != nil {
		return err
	}
	if *accountID == "" && settings.ActiveAccountID != "" {
		*accountID = settings.ActiveAccountID
	}

	account, err := st.LoadAccount(*accountID)
	if err != nil {
		return err
	}

	if settings.ActiveAccountID == "" {
		settings.ActiveAccountID = account.ID
		_ = st.SaveSettings(settings)
	}

	if len(settings.Rules) == 0 {
		return fmt.Errorf("relay settings are incomplete; configure at least one enabled rule in the UI first")
	}

	engine := relay.NewEngine(st, settingsLoader)
	client := weixin.NewClient(settings.Weixin)
	poller := weixin.NewPoller(client, st, engine)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	fmt.Printf("Relay started for account %s (%s)\n", account.ID, account.UserID)
	if err := poller.Run(ctx, account); err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	return nil
}

func runAdmin(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	addr := fs.String("addr", "", "admin listen address, e.g. :8080")
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if *addr != "" {
		cfg.Admin.ListenAddr = *addr
	}

	st, err := store.New(cfg.DataDir)
	if err != nil {
		return err
	}

	server := NewAdminServer(cfg, st)
	return server.Run()
}
