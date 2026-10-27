#!/usr/bin/env bash
#
# 邮件营销系统 · 升级脚本
# 用法：sudo bash upgrade.sh            # 升级到远端当前分支
#       sudo bash upgrade.sh v1.2.0     # 升级到指定 tag（也可用于回滚）
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/mailer}"
APP_USER="${APP_USER:-mailer}"
TARGET="${1:-}"

cd "$APP_DIR"

if [[ -n "$TARGET" ]]; then
  git fetch --tags --prune
  git checkout "$TARGET"
else
  git pull --ff-only
fi

# 构建产物属主必须回到运行用户，否则 systemd 起不来
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> 安装依赖（含 dev，构建需要）"
pnpm install --frozen-lockfile

echo "==> 构建"
pnpm -r build

echo "==> 数据库迁移"
pnpm --filter @mailer/api exec prisma migrate deploy

echo "==> 重启服务"
systemctl restart mailer-api mailer-worker
sleep 2
systemctl is-active --quiet mailer-api || { echo "mailer-api 启动失败，看 journalctl -u mailer-api -n 50" >&2; exit 1; }
systemctl is-active --quiet mailer-worker || { echo "mailer-worker 启动失败，看 journalctl -u mailer-worker -n 50" >&2; exit 1; }

echo "==> 完成，当前版本：$(git describe --tags --always)"
echo "回滚：sudo bash deploy/upgrade.sh 上一个tag   （数据库迁移不会自动回退，回滚前先确认）"
