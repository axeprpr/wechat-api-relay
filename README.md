# wechat-api-relay

[English](./README_EN.md)

`wechat-api-relay` 是一个基于 OpenClaw 微信通道协议的通用接入网关。

它的核心思路不是“自己实现微信协议”，而是 **hook / 复用 `@tencent-weixin/openclaw-weixin` 这一套 OpenClaw 微信接口能力**，把其中已经跑通的：

- 微信扫码登录
- 会话上下文 token
- 长轮询收消息
- 回发微信消息

这一层抽出来，变成一个可独立部署的中间件。

然后你就可以在这个中间件里，把微信消息转发到 **任意 HTTP API**，而不只是大模型 API。

管理台 UI 采用 `shadcn-admin` 风格重做，核心场景是：

- 微信扫码登录
- 选择活动账号
- 配置任意 API 转发规则
- 启停中继
- 把接口响应回发给微信

## 它适合做什么

你可以把它理解成：

`微信 <-> OpenClaw 微信接口 <-> wechat-api-relay <-> 任意业务 API`

适用场景包括：

- 把微信接到你自己的大模型网关
- 把微信接到知识库、搜索、工单、审批、CRM、告警系统
- 把微信变成企业内部 HTTP 服务的统一入口
- 用规则把不同前缀消息路由到不同 API

它不是一个“只会转 OpenAI 接口”的小工具，而是一个 **可规则化配置的微信 API Relay**。

## 核心能力

- 支持 OpenClaw 微信协议的扫码登录与长轮询收消息
- 支持任意 HTTP API 转发，而不只限于大模型接口
- 支持规则匹配：`all`、`prefix`、`contains`、`exact`、`regex`
- 支持 URL / Header / Query / Body 模板
- 支持 Response 模板，把上游返回映射成微信文本
- 支持本地 Web 管理台
- 支持打包为 `deb`、`rpm`、`tar.gz`
- 支持 GitHub Actions 自动构建与发布

## 项目结构

```text
.
├── internal/
│   ├── relay/        # 规则引擎与 HTTP 转发
│   ├── store/        # 设置、账号、会话存储
│   └── weixin/       # 微信登录、轮询、收发消息
├── web/              # 管理台前端
├── packaging/        # deb/rpm 打包配置与 systemd 服务
├── docs/             # 中英文部署文档
└── .github/workflows # CI / Release
```

## 快速开始

### 1. 构建

```bash
go build -o dist/wechat-api-relay .
cd web && npm install && npm run build && cd ..
```

### 2. 启动管理台

```bash
./dist/wechat-api-relay serve --addr 0.0.0.0:3222
```

打开：

```text
http://127.0.0.1:3222/
```

### 3. 在管理台里完成配置

1. 配置微信网关参数。
2. 点击 `Start Login`，用微信扫码。
3. 选择活动账号。
4. 配置一条或多条 API 转发规则。
5. 点击 `Start Relay`。

## 工作原理

整体链路：

1. 微信用户给 bot 发消息
2. `wechat-api-relay` 通过 OpenClaw 微信接口长轮询收到消息
3. 中继按规则匹配当前消息
4. 命中的规则把消息渲染成 HTTP 请求
5. 请求发到你的任意 API
6. 上游响应再经过模板映射，回发到微信

所以它本质上是：

- 下游：对接微信
- 上游：对接任意 HTTP API
- 中间：做消息路由、模板渲染、响应映射

## 规则模型

每条规则包含：

- `match`: 如何匹配消息
- `target`: 如何构造 HTTP 请求
- `response`: 如何把上游返回映射成微信回复
- `conversation`: 是否保存会话历史

典型规则示例：

```json
{
  "id": "echo-api",
  "name": "Echo API",
  "enabled": true,
  "match": {
    "mode": "prefix",
    "pattern": "/echo"
  },
  "target": {
    "method": "POST",
    "url_template": "https://example.com/echo",
    "headers": {
      "Content-Type": "application/json",
      "Authorization": "Bearer {{ .Account.id }}"
    },
    "query": {},
    "body_template": "{\"text\":\"{{ .Message.text }}\",\"from\":\"{{ .Message.from }}\"}",
    "timeout_ms": 30000,
    "insecure_skip_tls": false
  },
  "response": {
    "template": "{{ .Response.body }}"
  },
  "conversation": {
    "save_history": false,
    "history_limit": 12
  }
}
```

## 模板变量

可以在 URL、Header、Query、Body、Response 模板中引用：

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

## OpenAI 兼容接口预置规则

默认会生成一条 `OpenAI Compatible LLM` 规则，方便你开箱即用接大模型。

但它只是一个默认样例，不是系统唯一形态。你可以把它删掉，换成任意 REST API，比如：

- `POST /chat`
- `POST /workflow/run`
- `POST /ticket/create`
- `GET /search?q=...`
- 企业内部任意网关接口

## 打包

### 本地打包

需要安装 `nfpm`：

```bash
make package VERSION=0.1.0
```

产物：

- `dist/wechat-api-relay` 原始 Linux 可执行文件
- `dist/packages/*.deb`
- `dist/packages/*.rpm`
- `dist/packages/*linux_amd64.tar.gz`

## CI / Release

- `CI`: push / PR 时构建 Go 后端和前端
- `Release`: tag `v*` 或手动触发时构建并上传 `deb`、`rpm`、`tar.gz`

## 部署文档

- 中文部署手册：[docs/DEPLOYMENT.zh-CN.md](./docs/DEPLOYMENT.zh-CN.md)
- English deployment guide: [docs/DEPLOYMENT.en.md](./docs/DEPLOYMENT.en.md)

## 致谢

- 微信通讯链路参考 `@tencent-weixin/openclaw-weixin`
- 管理台视觉方向参考 `satnaing/shadcn-admin`
