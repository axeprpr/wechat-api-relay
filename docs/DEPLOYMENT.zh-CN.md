# 部署手册

## 1. 本地源码部署

### 依赖

- Go 1.25+
- Node.js 24+

### 构建

```bash
git clone <your-repo>
cd wechat-api-relay
go build -o dist/wechat-api-relay .
cd web && npm install && npm run build && cd ..
```

### 启动管理台

```bash
./dist/wechat-api-relay serve --addr 0.0.0.0:3222
```

访问：

```text
http://<your-host>:3222/
```

## 2. deb / rpm 安装

安装后：

- 二进制：`/usr/bin/wechat-api-relay`
- 前端静态资源：`/usr/share/wechat-api-relay/web/dist`
- systemd 服务：`/etc/systemd/system/wechat-api-relay.service`

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

## 3. 运行目录和数据

默认数据目录：

```text
$HOME/.wechat-api-relay
```

主要内容：

- `accounts/`: 微信登录凭证
- `pollers/`: `get_updates_buf` 游标
- `conversations/`: 会话历史
- `settings.json`: 管理台保存的微信配置和规则配置

## 4. 首次配置

1. 打开管理台。
2. 配置微信网关地址。
3. 新建或修改转发规则。
4. 点击 `Start Login` 扫码绑定微信。
5. 选择 `Active Account`。
6. 点击 `Start Relay`。

## 5. 规则模板变量

可在 URL、Header、Query、Body、Response 模板中使用：

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

## 6. 反向代理

建议在生产中使用 Nginx 或 Caddy 反向代理 `3222` 端口，并限制来源 IP。

## 7. 升级

### 源码方式

```bash
git pull
go build -o dist/wechat-api-relay .
cd web && npm install && npm run build && cd ..
sudo systemctl restart wechat-api-relay
```

### 包管理方式

直接安装新版 deb/rpm，然后重启服务。
