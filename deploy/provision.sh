#!/usr/bin/env bash
#
# 邮件营销系统 · Debian 12 裸机初始化
#
# 做四件事：装依赖与 Node、建系统用户和目录、初始化 PostgreSQL、安装 systemd 与备份
# 幂等：重复执行不会破坏已有数据（密码文件、环境变量文件只创建一次）
#
# 用法：
#   sudo bash provision.sh
#   sudo ADMIN_PASSWORD='你的密码' bash provision.sh
#
set -euo pipefail

APP_USER="${APP_USER:-mailer}"
APP_DIR="${APP_DIR:-/opt/mailer}"
CONF_DIR="${CONF_DIR:-/etc/mailer}"
ENV_FILE="$CONF_DIR/mailer.env"
DB_NAME="${DB_NAME:-mailer}"
DB_USER="${DB_USER:-mailer}"
NODE_MAJOR="${NODE_MAJOR:-22}"
NODE_VERSION="${NODE_VERSION:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m!!\033[0m %s\n' "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || die "请用 root 执行（sudo bash provision.sh）"
# shellcheck disable=SC1091
. /etc/os-release
[[ "${ID:-}" == "debian" ]] || die "本脚本仅针对 Debian，当前是 ${ID:-unknown}"
if [[ "${VERSION_ID:-}" != "12" ]]; then
  warn "脚本按 Debian 12 编写，当前是 ${VERSION_ID:-unknown}，继续执行但请留意包名差异"
fi

# ---------- 1. 系统依赖 ----------
log "安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  curl ca-certificates xz-utils git openssl logrotate \
  nginx postgresql postgresql-contrib python3-bcrypt

# ---------- 2. Node.js ----------
if command -v node >/dev/null 2>&1 && [[ "$(node -v)" == "v${NODE_MAJOR}."* ]]; then
  log "Node 已就绪：$(node -v)"
else
  case "$(uname -m)" in
    x86_64)  NARCH=x64 ;;
    aarch64) NARCH=arm64 ;;
    *) die "不支持的 CPU 架构：$(uname -m)" ;;
  esac

  if [[ -z "$NODE_VERSION" ]]; then
    log "解析 Node ${NODE_MAJOR} 最新版本"
    NODE_VERSION=$(curl -fsSL --max-time 20 https://nodejs.org/dist/index.json 2>/dev/null \
      | grep -oE "\"version\":\"v${NODE_MAJOR}\.[0-9]+\.[0-9]+\"" \
      | head -1 | grep -oE "[0-9]+\.[0-9]+\.[0-9]+") || true
  fi
  # 解析失败时退回一个确定存在的 LTS 版本
  NODE_VERSION="${NODE_VERSION:-22.11.0}"

  PKG="node-v${NODE_VERSION}-linux-${NARCH}.tar.xz"
  TMPD=$(mktemp -d)
  log "下载 $PKG"
  if ! curl -fsSL --max-time 180 "https://nodejs.org/dist/v${NODE_VERSION}/${PKG}" -o "$TMPD/$PKG"; then
    warn "官方源不可达，改用国内镜像"
    curl -fsSL --max-time 180 "https://npmmirror.com/mirrors/node/v${NODE_VERSION}/${PKG}" -o "$TMPD/$PKG" \
      || die "Node 下载失败，可用 NODE_VERSION=x.y.z 指定一个确定存在的版本重试"
  fi

  install -d /usr/local/lib/nodejs
  tar -xJf "$TMPD/$PKG" -C /usr/local/lib/nodejs
  ln -sfn "/usr/local/lib/nodejs/node-v${NODE_VERSION}-linux-${NARCH}" /usr/local/lib/nodejs/current
  for b in node npm npx corepack; do
    [[ -e "/usr/local/lib/nodejs/current/bin/$b" ]] && ln -sf "/usr/local/lib/nodejs/current/bin/$b" "/usr/local/bin/$b"
  done
  # 全局包默认会装到 node 自带的 bin 目录，那里不在 PATH 上，统一改到 /usr/local
  npm config set prefix /usr/local
  rm -rf "$TMPD"
  hash -r
  log "Node 安装完成：$(node -v)"
fi

# 修正历史遗留的 prefix 设置（旧版本装到 node 自带 bin 目录时 pnpm 会找不到）
NODE_PREFIX="$(npm config get prefix 2>/dev/null || echo /usr/local)"
if [[ "$NODE_PREFIX" != "/usr/local" ]]; then
  npm config set prefix /usr/local
  hash -r
fi

if ! command -v pnpm >/dev/null 2>&1; then
  log "安装 pnpm"
  npm install -g pnpm@9 >/dev/null 2>&1
  hash -r
fi
command -v pnpm >/dev/null 2>&1 || die "pnpm 安装失败，请检查 npm 源"
log "pnpm $(pnpm -v)"

# ---------- 3. 系统用户与目录 ----------
log "创建用户与目录"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi
install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_DIR"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_DIR/shared/uploads"
install -d -o "$APP_USER" -g "$APP_USER" -m 750 "$APP_DIR/shared/tmp"
install -d -o root -g "$APP_USER" -m 750 "$CONF_DIR"
install -d -m 700 /var/backups/mailer

# ---------- 4. PostgreSQL ----------
log "初始化数据库"
systemctl enable --now postgresql >/dev/null 2>&1 || systemctl restart postgresql

DB_PASS_FILE="$CONF_DIR/db.pass"
if [[ ! -f "$DB_PASS_FILE" ]]; then
  install -m 600 /dev/null "$DB_PASS_FILE"
  openssl rand -hex 24 > "$DB_PASS_FILE"
fi
DB_PASS=$(tr -d '\n' < "$DB_PASS_FILE")

# postgres 用户无法进入 /root（700），所有命令统一在 / 下执行
pg() { ( cd / && runuser -u postgres -- "$@" ); }

if ! pg psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
  pg psql -qc "CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}'"
  log "已创建数据库角色 ${DB_USER}"
else
  pg psql -qc "ALTER ROLE ${DB_USER} PASSWORD '${DB_PASS}'"
fi

if ! pg psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  pg createdb -O "$DB_USER" "$DB_NAME"
  log "已创建数据库 ${DB_NAME}"
fi

# ---------- 5. 环境变量文件 ----------
# 三个值可由外部传入（install.sh 会传），不传则用占位默认值：
#   ADMIN_EMAIL    管理员登录邮箱
#   APP_URL        面板地址，必须是最终用户会访问的地址（追踪与退订链接基于它生成）
#   TLS_CERT_PATH  证书文件路径，供面板的到期检查使用
APP_URL_VAL="${APP_URL:-https://mail.example.com}"
ADMIN_EMAIL_VAL="${ADMIN_EMAIL:-admin@example.com}"
TLS_CERT_PATH_VAL="${TLS_CERT_PATH:-}"

if [[ -f "$ENV_FILE" ]]; then
  log "环境变量文件已存在，保留原值：$ENV_FILE"
  ADMIN_PASSWORD=""
else
  log "生成环境变量文件"
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(openssl rand -base64 12 | tr -dc 'A-Za-z0-9' | cut -c1-16)}"
  ADMIN_HASH=$(python3 -c 'import bcrypt,sys;print(bcrypt.hashpw(sys.argv[1].encode(),bcrypt.gensalt(12)).decode())' "$ADMIN_PASSWORD")
  JWT_SECRET=$(openssl rand -hex 32)
  CRED_KEY=$(openssl rand -hex 32)

  cat > "$ENV_FILE" <<EOF
# 由 provision.sh 生成 $(date -Iseconds)
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}

# 面板地址。追踪像素、点击跳转、退订链接全部基于它生成，必须与用户实际访问的地址一致
APP_URL=${APP_URL_VAL}
TRACKING_BASE_URL=${APP_URL_VAL}

ADMIN_EMAIL=${ADMIN_EMAIL_VAL}
ADMIN_PASSWORD_HASH=${ADMIN_HASH}
JWT_SECRET=${JWT_SECRET}
CRED_KEY=${CRED_KEY}

UPLOAD_DIR=${APP_DIR}/shared/uploads
TMP_DIR=${APP_DIR}/shared/tmp
LOG_LEVEL=info

# 运维自检用：配了这两项，面板才能提示备份时效与证书到期
BACKUP_DIR=/var/backups/mailer
TLS_CERT_PATH=${TLS_CERT_PATH_VAL}
EOF
  chown root:"$APP_USER" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  log "环境变量写入 $ENV_FILE（640 root:${APP_USER}）"

  # 初始密码另存一份，供 install.sh 在全部装完后一次性展示。
  # 只写 stdout 的话，装到一半失败就再也看不到了。
  if [[ -n "$ADMIN_PASSWORD" ]]; then
    install -m 600 /dev/null "$CONF_DIR/initial-password"
    printf '%s\n' "$ADMIN_PASSWORD" > "$CONF_DIR/initial-password"
  fi
fi

# ---------- 6. systemd 服务 ----------
if compgen -G "$HERE/systemd/mailer-*.service" >/dev/null; then
  log "安装 systemd 服务"
  install -m 644 "$HERE"/systemd/mailer-*.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable mailer-api.service mailer-worker.service >/dev/null 2>&1 || true
  log "已 enable（首次部署构建完成后执行 systemctl start）"
else
  warn "未找到 systemd/mailer-*.service，跳过"
fi

# ---------- 7. journald 容量限制 ----------
install -d -m 755 /etc/systemd/journald.conf.d
if [[ ! -f /etc/systemd/journald.conf.d/mailer.conf ]]; then
  cat > /etc/systemd/journald.conf.d/mailer.conf <<'EOF'
[Journal]
SystemMaxUse=512M
SystemMaxFileSize=64M
EOF
  systemctl restart systemd-journald
fi

# ---------- 8. 备份与恢复 ----------
if [[ -f "$HERE/backup.sh" ]]; then
  log "安装备份脚本与定时任务"
  install -m 750 "$HERE/backup.sh" /usr/local/sbin/mailer-backup
  cat > /etc/cron.d/mailer-backup <<'EOF'
# 每天 03:15 备份数据库与附件，保留 14 天
# SHELL/PATH 必须显式写：cron 默认 PATH 只有 /usr/bin:/bin，而 pg 相关工具在 /usr/sbin，
# 缺了就会 "runuser: command not found"，且失败信息被丢进 /dev/null 完全看不见。
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
15 3 * * * root /usr/local/sbin/mailer-backup >>/var/log/mailer-backup.log 2>&1
EOF
  chmod 644 /etc/cron.d/mailer-backup
fi

if [[ -f "$HERE/restore.sh" ]]; then
  log "安装恢复脚本（默认演练模式，不会覆盖生产库）"
  install -m 750 "$HERE/restore.sh" /usr/local/sbin/mailer-restore
fi

# ---------- 9. Nginx 站点（不自动启用） ----------
if [[ -f "$HERE/nginx/mailer.conf" ]]; then
  install -m 644 "$HERE/nginx/mailer.conf" /etc/nginx/sites-available/mailer
  systemctl enable --now nginx >/dev/null 2>&1 || true
  log "站点配置已放到 /etc/nginx/sites-available/mailer"
fi

# ---------- 10. 结果 ----------
cat <<EOF

────────────────────────────────────────────
系统准备完成
────────────────────────────────────────────
应用目录      ${APP_DIR}
配置文件      ${ENV_FILE}
上传目录      ${APP_DIR}/shared/uploads
备份目录      /var/backups/mailer（每天 03:15，保留 14 天）
数据库        postgresql://${DB_USER}:***@127.0.0.1:5432/${DB_NAME}
数据库密码    ${DB_PASS_FILE}
EOF

if [[ -n "$ADMIN_PASSWORD" ]]; then
  cat <<EOF
管理员账号    ${ADMIN_EMAIL_VAL}
管理员密码    （已存入 ${CONF_DIR}/initial-password，由 install.sh 最后统一展示）
EOF
fi

cat <<EOF

────────────────────────────────────────────
这只是系统层，应用还没装。
继续执行（推荐，一条命令做完代码部署、构建、证书、启动）：

  sudo bash ${HERE}/install.sh --ip <本机公网IP> --email ${ADMIN_EMAIL_VAL}
  或
  sudo bash ${HERE}/install.sh --domain <你的域名> --email ${ADMIN_EMAIL_VAL}

只想先看会做什么、不改系统：

  sudo bash ${HERE}/install.sh --domain <域名> --email <邮箱> --check
EOF
