#!/bin/sh
set -eu

mkdir -p /var/lib/wechat-api-relay

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
fi
