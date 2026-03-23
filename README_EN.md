# wechat-api-relay

[简体中文](./README.md)

A generic WeChat-to-HTTP relay gateway. It hooks into and reuses the WeChat transport protocol exposed by `@tencent-weixin/openclaw-weixin`, then routes inbound WeChat messages to arbitrary HTTP APIs through configurable rules.

The admin UI is rebuilt in the visual direction of `shadcn-admin` and focuses on:

- WeChat QR login
- Active account selection
- Arbitrary HTTP rule management
- Runtime start/stop
- Sending upstream responses back to WeChat

## Features

- QR login and long-poll messaging for the OpenClaw WeChat protocol
- Arbitrary HTTP API forwarding, not limited to LLM APIs
- Rule matching modes: `all`, `prefix`, `contains`, `exact`, `regex`
- URL / Header / Query / Body templating
- Response templating for WeChat replies
- Local web admin UI
- `deb`, `rpm`, and `tar.gz` packaging
- GitHub Actions CI and release pipelines

## Build

```bash
go build -o dist/wechat-api-relay .
cd web && npm install && npm run build && cd ..
```

## Run

```bash
./dist/wechat-api-relay serve --addr 0.0.0.0:3222
```

Open:

```text
http://127.0.0.1:3222/
```

## Rule model

Each rule defines:

- `match`: how a message is matched
- `target`: how the HTTP request is built
- `response`: how the upstream response is mapped to a WeChat reply
- `conversation`: whether local history should be stored

## Template variables

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

## Default preset

The project generates one default `OpenAI Compatible LLM` rule so the first setup is fast.  
It is only a preset. You can remove it and replace it with any REST API.

## Packaging

```bash
make package VERSION=0.1.0
```

Artifacts:

- `dist/wechat-api-relay` raw Linux binary
- `dist/packages/*.deb`
- `dist/packages/*.rpm`

## Deployment docs

- Chinese: [docs/DEPLOYMENT.zh-CN.md](./docs/DEPLOYMENT.zh-CN.md)
- English: [docs/DEPLOYMENT.en.md](./docs/DEPLOYMENT.en.md)

## Credits

- WeChat transport flow based on `@tencent-weixin/openclaw-weixin`
- Admin UI visual direction inspired by `satnaing/shadcn-admin`
## Positioning

The intended architecture is:

`WeChat <-> OpenClaw WeChat transport <-> wechat-api-relay <-> arbitrary HTTP APIs`

This project is not limited to OpenAI-compatible models. The default LLM rule is only a starter preset. The relay is meant to be a generic WeChat ingress layer for:

- internal tools
- search endpoints
- approval flows
- ticket systems
- workflow engines
- knowledge APIs
- custom business services
