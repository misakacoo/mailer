#!/usr/bin/env bash
#
# certbot deploy-hook：证书续期后同步一份副本给应用，并重载 Nginx。
# 安装位置：/usr/local/sbin/mailer-cert-hook
#
# 为什么要复制：/etc/letsencrypt/live 是 700 root，服务以 mailer 用户运行，
# 直接读会 EACCES，面板的"证书还剩几天"检查就永远是失败。
# 副本放在应用自己的可读目录，续期时自动更新，不会读到过期的那份。
#
set -euo pipefail

CERT_DIR="${CERT_DIR:-/opt/mailer/shared/certs}"
APP_USER="${APP_USER:-mailer}"

install -d -m 750 -o "$APP_USER" -g "$APP_USER" "$CERT_DIR" 2>/dev/null \
  || mkdir -p "$CERT_DIR"

found=0
for f in /etc/letsencrypt/live/*/cert.pem; do
  [[ -f "$f" ]] || continue
  name=$(basename "$(dirname "$f")")
  install -m 640 -o "$APP_USER" -g "$APP_USER" "$f" "$CERT_DIR/$name.crt"
  echo "已同步证书副本：$CERT_DIR/$name.crt"
  found=$((found + 1))
done

if [[ "$found" -eq 0 ]]; then
  echo "警告：未找到任何证书，跳过副本同步" >&2
fi

# 证书换了必须重载，否则 Nginx 还在用旧证书
if systemctl is-active --quiet nginx; then
  systemctl reload nginx
  echo "已重载 Nginx"
fi
