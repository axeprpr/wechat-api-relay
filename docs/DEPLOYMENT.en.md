# Deployment Guide

## 1. Local source deployment

Requirements:

- Go 1.25+
- Node.js 24+

Build:

```bash
git clone <your-repo>
cd wechat-api-relay
go build -o dist/wechat-api-relay .
cd web && npm install && npm run build && cd ..
```

Run:

```bash
./dist/wechat-api-relay serve --addr 0.0.0.0:3222
```

Open:

```text
http://<your-host>:3222/
```

## 2. deb / rpm installation

Installed paths:

- Binary: `/usr/bin/wechat-api-relay`
- Frontend assets: `/usr/share/wechat-api-relay/web/dist`
- systemd unit: `/etc/systemd/system/wechat-api-relay.service`

### Debian / Ubuntu

```bash
sudo dpkg -i wechat-api-relay_<version>_linux_amd64.deb
sudo systemctl enable --now wechat-api-relay
```

### RHEL / Rocky / CentOS / Fedora

```bash
sudo rpm -ivh wechat-api-relay-<version>-1.x86_64.rpm
sudo systemctl enable --now wechat-api-relay
```

## 3. Data directory

Default:

```text
$HOME/.wechat-api-relay
```

Contains:

- `accounts/`: WeChat login credentials
- `pollers/`: `get_updates_buf` cursor
- `conversations/`: stored conversation history
- `settings.json`: saved channel and routing configuration

## 4. First-time setup

1. Open the admin UI.
2. Configure the WeChat gateway.
3. Create or edit forwarding rules.
4. Click `Start Login` and scan the QR code.
5. Choose the `Active Account`.
6. Click `Start Relay`.

## 5. Template variables

Available in URL, header, query, body, and response templates:

```gotemplate
{{ .Message.text }}
{{ .Message.from }}
{{ .Message.context_token }}
{{ .Account.id }}
{{ .Account.raw_id }}
{{ .Account.user_id }}
{{ .Now.rfc3339 }}
{{ .Response.status_code }}
{{ .Response.body }}
{{ .Response.json }}
{{ .Response.headers }}
```

## 6. Reverse proxy

For production, place Nginx or Caddy in front of port `3222` and restrict access.
