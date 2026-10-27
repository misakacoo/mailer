#!/usr/bin/env bash
#
# 邮件营销系统 · 一键部署（Debian 12 裸机，全新机器或迁移）
#
# 把「系统初始化 → 代码部署 → 构建 → 建表 → 签证书 → 起服务 → 自检」
# 全部串起来。之前这些步骤有一半是手工做的，这个脚本把它们固化。
#
# 用法：
#   sudo bash deploy/install.sh --ip 1.2.3.4      --email you@example.com
#   sudo bash deploy/install.sh --domain mail.x.com --email you@example.com
#
# 常用可选项：
#   --check                   只体检并打印计划，不改动系统
#   --skip-cert               先不签证书，跑在 HTTP 上（内网/调试用）
#   --restore <dump>          装完后恢复一份 pg_dump 备份
#   --env-file <path>         沿用旧机器的 mailer.env（迁移时必须，否则 SMTP 密码解不开）
#   --skip-build              代码没变时跳过 pnpm build，只重启服务
#
set -euo pipefail

# 统一 PATH：从 cron、systemd 或其他精简环境被调起时，pg/runuser 等工具在 /usr/sbin，
# 缺了会以 "command not found" 的形式在某个中间步骤静默断掉。
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$ROOT/app"

APP_USER="${APP_USER:-mailer}"
APP_DIR="${APP_DIR:-/opt/mailer}"
CONF_DIR="${CONF_DIR:-/etc/mailer}"
ENV_FILE="$CONF_DIR/mailer.env"
CERTBOT_DIR="/opt/certbot"
WEBROOT="/var/www/html"

MODE=""
TARGET=""
EMAIL=""
CHECK_ONLY=0
SKIP_CERT=0
SKIP_BUILD=0
RESTORE_FILE=""
REUSE_ENV=""

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m  ✗\033[0m %s\n' "$*" >&2; exit 1; }

# 改写 env 里的单个键值。用 | 作分隔符，避免 bcrypt 哈希里的 / 与 sed 冲突
set_env() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

usage() {
  sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ip)        MODE=ip;     TARGET="${2:-}"; shift 2 ;;
    --domain)    MODE=domain; TARGET="${2:-}"; shift 2 ;;
    --email)     EMAIL="${2:-}";  shift 2 ;;
    --restore)   RESTORE_FILE="${2:-}"; shift 2 ;;
    --env-file)  REUSE_ENV="${2:-}"; shift 2 ;;
    --check)     CHECK_ONLY=1; shift ;;
    --skip-cert) SKIP_CERT=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    -h|--help)   usage ;;
    *) die "未知参数：$1（用 --help 看用法）" ;;
  esac
done

# ---------------------------------------------------------------- 前置检查

detect_public_ip() {
  # 用默认路由的源地址，比问外部接口可靠（也不需要出网权限）
  ip route get 1.1.1.1 2>/dev/null | grep -oE 'src [0-9.]+' | awk '{print $2}' | head -1
}

preflight() {
  log "前置检查"

  [[ "${EUID}" -eq 0 ]] || die "请用 root 执行"
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "debian" ]] || die "只支持 Debian，当前是 ${ID:-unknown}"
  [[ "${VERSION_ID:-}" == "12" ]] || warn "按 Debian 12 编写，当前 ${VERSION_ID:-unknown}，包名可能有差异"
  ok "系统：$(. /etc/os-release; echo "$PRETTY_NAME")"

  [[ -d "$SRC/apps/api" ]] || die "找不到应用代码：$SRC/apps/api（整个项目目录要一起上传）"
  ok "代码目录：$SRC"

  [[ -n "$TARGET" ]] || die "必须指定 --ip 或 --domain"
  [[ -n "$EMAIL" ]] || die "必须指定 --email（证书到期通知与管理员账号都用它）"

  PUBLIC_IP="$(detect_public_ip)"
  [[ -n "$PUBLIC_IP" ]] || warn "拿不到本机公网 IP，跳过后面的比对"

  if [[ "$MODE" == "ip" ]]; then
    [[ "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--ip 参数不是合法 IPv4：$TARGET"
    if [[ -n "$PUBLIC_IP" && "$TARGET" != "$PUBLIC_IP" ]]; then
      warn "指定的 IP $TARGET 与本机出口 IP $PUBLIC_IP 不一致 —— IP 证书会签发失败"
    fi
    SITE_URL="https://$TARGET"
    CERT_NAME="$TARGET"
  else
    RESOLVED="$(getent ahostsv4 "$TARGET" 2>/dev/null | awk '{print $1}' | head -1 || true)"
    if [[ -z "$RESOLVED" ]]; then
      warn "域名 $TARGET 解析不到任何地址 —— 证书签发会失败，先把 DNS A 记录指过来"
    elif [[ -n "$PUBLIC_IP" && "$RESOLVED" != "$PUBLIC_IP" ]]; then
      warn "域名解析到 $RESOLVED，但本机出口 IP 是 $PUBLIC_IP —— 证书签发会失败"
    else
      ok "域名解析正常：$TARGET → $RESOLVED"
    fi
    SITE_URL="https://$TARGET"
    CERT_NAME="$TARGET"
  fi

  if [[ "$SKIP_CERT" -eq 1 ]]; then
    SITE_URL="http://$TARGET"
    warn "--skip-cert 已指定，将跑在 ${SITE_URL}（Cookie 不带 Secure）"
  fi

  for p in 80 443; do
    HOLDER=$(ss -tlnpH "sport = :$p" 2>/dev/null \
      | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | head -1 || true)
    if [[ -z "$HOLDER" ]]; then
      ok "端口 $p 空闲"
    elif [[ "$HOLDER" == nginx* ]]; then
      # 已有安装在跑时这是正常状态，不能当成告警吓人
      ok "端口 $p 由 nginx 占用（稍停即 reload，不会中断）"
    else
      warn "端口 $p 被 $HOLDER 占用，证书签发会失败（先 systemctl stop $HOLDER）"
    fi
  done

  if [[ -f "$ENV_FILE" ]]; then
    warn "检测到已有安装在 $APP_DIR —— 本次按「升级/修复」处理，不会覆盖数据与密钥"
    UPGRADE=1
  else
    UPGRADE=0
  fi

  [[ -n "$REUSE_ENV" ]] && { [[ -f "$REUSE_ENV" ]] || die "--env-file 指向的文件不存在：$REUSE_ENV"; }

  if [[ -n "$RESTORE_FILE" ]]; then
    [[ -f "$RESTORE_FILE" ]] || die "--restore 指向的备份不存在：$RESTORE_FILE"
    [[ $(stat -c%s "$RESTORE_FILE") -ge 1024 ]] || die "备份文件过小，疑似损坏：$RESTORE_FILE"
  fi

  FREE_GB=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
  [[ "${FREE_GB:-0}" -ge 3 ]] || warn "根分区剩余 ${FREE_GB}G，构建和备份可能不够，建议至少 3G"
  MEM_MB=$(free -m | awk '/^Mem:/{print $2}')
  [[ "${MEM_MB:-0}" -ge 900 ]] || warn "内存只有 ${MEM_MB}M，pnpm build 可能被 OOM 杀掉"
  ok "磁盘剩余 ${FREE_GB}G，内存 ${MEM_MB}M"
}

show_plan() {
  cat <<EOF

────────────────────────────────────────────
将要执行（当前是 --check，不改动任何文件）
────────────────────────────────────────────
  1. 系统依赖：nginx / postgresql / python3-bcrypt / git
  2. Node 22 + pnpm 9（官方 tarball，不污染系统包）
  3. 建 ${APP_USER} 系统用户、${APP_DIR}、${CONF_DIR}
  4. PostgreSQL 建角色与库（密码写入 ${CONF_DIR}/db.pass）
  5. 生成 ${ENV_FILE}（JWT_SECRET / CRED_KEY 随机 32 字节）
  6. 安装 systemd 服务、备份与恢复脚本、证书钩子
  7. 代码复制到 ${APP_DIR}，pnpm install + build
  8. $( [[ -n "$RESTORE_FILE" ]] && echo "从 $(basename "$RESTORE_FILE") 恢复数据（会先备份当前库）" || echo "跳过数据恢复（未指定 --restore）" )
  9. prisma migrate deploy（先恢复再迁移，保证 schema 是代码对应的版本）
 10. $( [[ "$SKIP_CERT" -eq 0 ]] \
        && echo "申请证书（$( [[ "$MODE" == "ip" ]] && echo "IP 证书，shortlived 约 6 天有效" || echo "域名证书，90 天有效" )）" \
        || echo "跳过证书（--skip-cert，将跑在 HTTP 上）" )
 11. 渲染 nginx 配置并启用
 12. 启动 mailer-api / mailer-worker
 13. 自检并输出凭据

  站点地址：${SITE_URL}
  管理员：  ${EMAIL}
$( [[ "$UPGRADE" -eq 1 ]] && echo "
  注意：这台机器已有安装，第 5 步会保留现有密钥与管理员密码。" )
$( [[ -n "$REUSE_ENV" ]] && echo "  注意：将沿用 $REUSE_ENV 里的 CRED_KEY / JWT_SECRET / 管理员密码哈希。" )

确认无误后去掉 --check 重新执行。
EOF
}

# ---------------------------------------------------------------- 执行步骤

step_provision() {
  log "① 系统层初始化"
  APP_USER="$APP_USER" APP_DIR="$APP_DIR" CONF_DIR="$CONF_DIR" \
  ADMIN_EMAIL="$EMAIL" APP_URL="$SITE_URL" \
  TLS_CERT_PATH="/opt/mailer/shared/certs/$CERT_NAME.crt" \
    bash "$HERE/provision.sh" 2>&1 | sed 's/^/   /'
}

step_reuse_env() {
  [[ -n "$REUSE_ENV" ]] || return 0
  log "①' 沿用旧机器的密钥"

  # 这三样不能重新生成：CRED_KEY 换了 SMTP 密码全废，JWT_SECRET 换了所有会话失效，
  # 密码哈希换了登不进去。其余字段（数据库地址、站点地址）必须按新机器重写。
  local cred jwt hash
  cred=$(grep -E '^CRED_KEY=' "$REUSE_ENV" | head -1 | cut -d= -f2-)
  jwt=$(grep -E '^JWT_SECRET=' "$REUSE_ENV" | head -1 | cut -d= -f2-)
  hash=$(grep -E '^ADMIN_PASSWORD_HASH=' "$REUSE_ENV" | head -1 | cut -d= -f2-)

  [[ -n "$cred" ]] || die "旧 env 里找不到 CRED_KEY"
  [[ -n "$jwt"  ]] || die "旧 env 里找不到 JWT_SECRET"
  [[ -n "$hash" ]] || die "旧 env 里找不到 ADMIN_PASSWORD_HASH"

  set_env CRED_KEY "$cred"
  set_env JWT_SECRET "$jwt"
  set_env ADMIN_PASSWORD_HASH "$hash"
  ok "CRED_KEY / JWT_SECRET / 管理员密码哈希已沿用"
  ok "管理员密码仍是旧机器那一个，不用重设"
}

# 已有安装时 provision 会原样保留旧 env，这里把「与本次访问地址相关」的字段对齐。
# 不这么做的话，换 IP / 换域名重装后，追踪链接和退订链接仍指向旧地址。
step_align_env() {
  log "①'' 对齐站点地址"
  set_env APP_URL "$SITE_URL"
  set_env TRACKING_BASE_URL "$SITE_URL"
  set_env ADMIN_EMAIL "$EMAIL"
  if [[ "$SKIP_CERT" -eq 0 ]]; then
    set_env TLS_CERT_PATH "/opt/mailer/shared/certs/$CERT_NAME.crt"
  fi
  ok "APP_URL = $SITE_URL"
}

step_code() {
  log "② 部署代码到 $APP_DIR"
  install -d -o "$APP_USER" -g "$APP_USER" -m 755 "$APP_DIR"
  # 用 tar 管道而不是 cp -a：排除本机构建产物，也避免把 Windows 的权限位带过去
  tar -C "$SRC" --exclude=node_modules --exclude=dist -cf - . \
    | tar -C "$APP_DIR" -xf -
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
  ok "已复制 $(du -sh "$APP_DIR" | cut -f1) 代码"
}

run_as_app() {
  runuser -u "$APP_USER" -- bash -c "export PATH=/usr/local/bin:\$PATH HOME=$APP_DIR; cd $APP_DIR && $*"
}

step_build() {
  if [[ "$SKIP_BUILD" -eq 1 ]]; then
    log "③ 跳过构建（--skip-build）"
    [[ -f "$APP_DIR/apps/api/dist/main.js" ]] || die "--skip-build 但 ${APP_DIR}/apps/api/dist/main.js 不存在，去掉这个参数重跑"
    [[ -f "$APP_DIR/apps/web/dist/index.html" ]] || die "--skip-build 但前端 dist 不存在，去掉这个参数重跑"
    return 0
  fi

  log "③ 安装依赖并构建（首次约 3–5 分钟）"
  run_as_app "pnpm install" >/tmp/mailer-install.log 2>&1 || {
    tail -25 /tmp/mailer-install.log | sed 's/^/   /'
    die "依赖安装失败（完整日志 /tmp/mailer-install.log）"
  }
  ok "依赖就绪"

  # 刻意不用 `| grep xxx || true`：那样构建失败会被吞掉，
  # 只能靠检查产物来兜底，而旧产物会让人误以为这次构建成功了。
  run_as_app "pnpm -r build" >/tmp/mailer-build.log 2>&1 || {
    tail -30 /tmp/mailer-build.log | sed 's/^/   /'
    die "构建失败（完整日志 /tmp/mailer-build.log）"
  }
  grep -E 'built in|Done' /tmp/mailer-build.log | tail -3 | sed 's/^/   /'

  [[ -f "$APP_DIR/apps/api/dist/main.js" ]] || die "后端构建产物缺失（dist/main.js）"
  [[ -f "$APP_DIR/apps/web/dist/index.html" ]] || die "前端构建产物缺失（dist/index.html）"
  ok "前后端构建完成"
}

step_db() {
  log "⑤ 迁移对齐（把 schema 补到代码对应的版本）"
  # migrate deploy 只跑未应用的迁移，不会重置数据。
  # 恢复过备份时，这一步正好把备份之后新增的建表补上。
  run_as_app "set -a; . $ENV_FILE; set +a; cd $APP_DIR/apps/api && pnpm exec prisma migrate deploy" 2>&1 \
    | grep -vE '^$' | sed 's/^/   /' || true

  local tables
  tables=$(bash -c "set -a; . $ENV_FILE; set +a; psql \"\$DATABASE_URL\" -tAc \"select count(*) from information_schema.tables where table_schema='public'\"" 2>/dev/null | tr -d ' ')
  [[ "${tables:-0}" -ge 12 ]] || die "表数量异常（${tables:-0} 张），迁移没跑完"
  ok "数据库就绪：${tables} 张表"
}

step_restore() {
  [[ -n "$RESTORE_FILE" ]] || return 0
  log "④ 恢复数据：$RESTORE_FILE"

  # 恢复前留一份当前库，出问题能退回去
  local safety="/var/backups/mailer/pre-restore-$(date +%Y%m%d-%H%M%S).dump"
  install -d -m 750 -o root -g postgres /var/backups/mailer
  ( cd / && runuser -u postgres -- pg_dump -Fc mailer ) > "$safety"
  chown root:postgres "$safety"; chmod 640 "$safety"
  ok "已备份当前库到 $safety"

  # 用库的 owner（mailer）身份恢复，而不是切到 postgres 用户。
  # 这样文件由 root 读，不受"备份放在 /root 或 700 目录"的权限折磨；
  # --no-owner 也意味着不需要超级用户权限。
  local restore_log=/tmp/mailer-restore.log
  bash -c "set -a; . $ENV_FILE; set +a; pg_restore --no-owner --no-privileges --clean --if-exists -d \"\$DATABASE_URL\" \"$RESTORE_FILE\"" \
    >"$restore_log" 2>&1 || true

  # pg_restore 对"对象本来就不存在"这类无害情况也会返回非 0，
  # 所以成败不用退出码判断，看数据到底进来没有。
  grep -vE '^$|NOTICE|does not exist, skipping' "$restore_log" | tail -5 | sed 's/^/   /' || true

  local contacts
  contacts=$(bash -c "set -a; . $ENV_FILE; set +a; psql \"\$DATABASE_URL\" -tAc 'select count(*) from contacts'" 2>/dev/null | tr -d ' \n' || true)
  [[ "${contacts:-0}" -gt 0 ]] || die "恢复失败：contacts 表为空或不可读（日志 /tmp/mailer-restore.log）"
  ok "恢复完成：${contacts} 个联系人"

  # 附件随包一起恢复。兼容两种命名：migrate.sh 产出的 uploads.tgz
  # 和 backup.sh 产出的 uploads-<时间戳>.tgz
  local tgz
  tgz=$(ls -1t "$(dirname "$RESTORE_FILE")"/uploads*.tgz 2>/dev/null | head -1 || true)
  if [[ -n "$tgz" ]]; then
    tar -xzf "$tgz" -C "$APP_DIR/shared"
    chown -R "$APP_USER:$APP_USER" "$APP_DIR/shared/uploads"
    ok "附件已恢复：$(basename "$tgz")"
  fi
}

step_certbot() {
  log "⑥ 安装 certbot"
  # Debian 12 仓库里的 certbot 2.x 不支持 IP 证书，必须用独立 venv 装新版
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -qq python3-venv >/dev/null 2>&1 || true
  if [[ ! -x "$CERTBOT_DIR/bin/certbot" ]]; then
    python3 -m venv "$CERTBOT_DIR"
    "$CERTBOT_DIR/bin/pip" install -q --upgrade pip setuptools wheel 2>&1 | tail -1 || true
    "$CERTBOT_DIR/bin/pip" install -q --upgrade certbot 2>&1 | tail -2 || true
  fi
  [[ -x "$CERTBOT_DIR/bin/certbot" ]] || die "certbot 安装失败"
  ok "certbot $("$CERTBOT_DIR/bin/certbot" --version 2>/dev/null | awk '{print $2}')"

  install -m 750 "$HERE/cert-hook.sh" /usr/local/sbin/mailer-cert-hook
  cat > /etc/cron.d/mailer-certbot <<'EOF'
# IP 证书只有 6 天有效期，必须高频检查续期。续期后同步副本并重载 nginx
17 3,15 * * * root /opt/certbot/bin/certbot renew --quiet --deploy-hook "/usr/local/sbin/mailer-cert-hook" >/dev/null 2>&1
EOF
  chmod 644 /etc/cron.d/mailer-certbot
  ok "证书钩子与续期任务已就位"
}

step_nginx_bootstrap() {
  log "⑦ 启用 HTTP 引导站点（签证书需要 80 端口可达）"
  install -d -m 755 "$WEBROOT/.well-known/acme-challenge"
  install -m 644 "$HERE/nginx/mailer.conf" /etc/nginx/sites-available/mailer

  # Debian 自带的 default 站点会抢 80 端口的 default_server
  rm -f /etc/nginx/sites-enabled/default
  ln -sfn /etc/nginx/sites-available/mailer /etc/nginx/sites-enabled/mailer

  nginx -t >/dev/null 2>&1 || die "nginx 配置有语法错误（引导态）"
  systemctl enable --now nginx >/dev/null 2>&1 || systemctl restart nginx
  systemctl reload nginx
  ok "HTTP 已就绪"

  echo "selftest-$(date +%s)" > "$WEBROOT/.well-known/acme-challenge/selftest"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1/.well-known/acme-challenge/selftest" || echo 000)
  rm -f "$WEBROOT/.well-known/acme-challenge/selftest"
  if [[ "$code" == "200" ]]; then
    ok "ACME 验证路径可达（HTTP 200）"
  else
    warn "ACME 验证路径返回 ${code}，证书签发可能失败（检查防火墙是否放行 80）"
  fi
}

step_cert() {
  CERT_OK=0
  if [[ "$SKIP_CERT" -eq 1 ]]; then
    log "⑧ 跳过证书（--skip-cert）"
    return 0
  fi

  log "⑧ 申请证书：$TARGET"
  local args=(
    certonly --webroot -w "$WEBROOT"
    --cert-name "$CERT_NAME"
    --non-interactive --agree-tos -m "$EMAIL"
    --deploy-hook "/usr/local/sbin/mailer-cert-hook"
  )
  if [[ "$MODE" == "ip" ]]; then
    # IP 证书被 LE 强制要求 shortlived 档案，有效期 160 小时
    args+=(--preferred-profile shortlived --ip-address "$TARGET")
  else
    args+=(-d "$TARGET")
  fi

  # 不能靠这条命令的退出码判断成败：管道最后一段是 sed，几乎总是返回 0。
  # 判据只有一个——证书文件到底有没有生成。
  "$CERTBOT_DIR/bin/certbot" "${args[@]}" 2>&1 | tail -12 | sed 's/^/   /' || true

  if [[ -f "/etc/letsencrypt/live/$CERT_NAME/fullchain.pem" ]]; then
    CERT_OK=1
    local exp
    exp=$("$CERTBOT_DIR/bin/certbot" certificates --cert-name "$CERT_NAME" 2>/dev/null | grep -oE 'Expiry Date: [^(]+' | head -1 || true)
    ok "证书已就绪 ${exp}"
  else
    warn "证书签发失败 —— 保持 HTTP 访问，站点仍可用"
    warn "常见原因：域名没解析到本机 / 80 端口被安全组挡住 / TARGET 不是本机公网 IP"
    warn "修好后重跑本脚本即可，已完成的步骤不会重复"
    SITE_URL="http://$TARGET"
    set_env APP_URL "$SITE_URL"
    set_env TRACKING_BASE_URL "$SITE_URL"
    set_env TLS_CERT_PATH ""
    ok "已把 APP_URL 回退成 ${SITE_URL}（否则 Cookie 带 Secure 会登不进去）"
  fi
}

step_nginx_final() {
  if [[ "${CERT_OK:-0}" -ne 1 ]]; then
    # 证书没签下来，保持引导态的 HTTP 配置，什么都不用换
    log "⑨ 保持 HTTP 配置"
    return 0
  fi

  log "⑨ 切换到 HTTPS 配置"
  sed "s|__CERT_NAME__|$CERT_NAME|g" "$HERE/nginx/mailer.template.conf" \
    > /etc/nginx/sites-available/mailer

  nginx -t >/dev/null 2>&1 || { warn "HTTPS 配置校验失败，回退到 HTTP"; install -m 644 "$HERE/nginx/mailer.conf" /etc/nginx/sites-available/mailer; nginx -t; }
  systemctl reload nginx
  ok "HTTPS 已启用：$SITE_URL"
}

step_services() {
  log "⑩ 启动服务"
  systemctl daemon-reload
  systemctl enable mailer-api mailer-worker >/dev/null 2>&1 || true
  systemctl restart mailer-api mailer-worker

  local i
  for i in $(seq 1 30); do
    if curl -fsS --max-time 2 http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
      ok "API 已就绪（${i}s）"
      break
    fi
    sleep 1
    [[ "$i" -eq 30 ]] && {
      warn "API 30 秒内没起来，最近的日志："
      journalctl -u mailer-api -n 20 --no-pager -o cat | sed 's/^/   /'
      die "启动失败"
    }
  done

  sleep 2
  systemctl is-active --quiet mailer-worker || warn "worker 没在跑，发送队列不会推进"
  ok "mailer-api / mailer-worker 均已启动"
}

step_verify() {
  log "⑪ 自检"
  local code
  code=$(curl -sk -o /dev/null -w '%{http_code}' "$SITE_URL/" || echo 000)
  [[ "$code" == "200" ]] && ok "首页 HTTP $code" || warn "首页返回 $code"

  local health
  health=$(curl -sk "$SITE_URL/api/health" || echo '')
  echo "$health" | grep -q '"db":"ok"' && ok "数据库连通" || warn "健康检查异常：$health"

  local unauth
  unauth=$(curl -sk -o /dev/null -w '%{http_code}' "$SITE_URL/api/stats/overview" || echo 000)
  [[ "$unauth" == "401" ]] && ok "鉴权正常（未登录返回 401）" || warn "未登录访问概览返回 $unauth，预期 401"

  bash -c "set -a; . $ENV_FILE; set +a; psql \"\$DATABASE_URL\" -tAc 'select 1'" >/dev/null 2>&1 \
    && ok "凭据文件可被应用读取" || warn "应用读不到 DATABASE_URL"
}

summary() {
  # 证书步骤可能被跳过，这里兜个底，避免 set -u 下取空变量报错
  CERT_OK="${CERT_OK:-0}"

  local admin_pass=""
  [[ -f "$CONF_DIR/initial-password" ]] && admin_pass=$(cat "$CONF_DIR/initial-password")

  local admin_hash
  admin_hash=$(grep -E '^ADMIN_PASSWORD_HASH=' "$ENV_FILE" | cut -d= -f2-)

  cat <<EOF

════════════════════════════════════════════
部署完成
════════════════════════════════════════════
  面板地址    ${SITE_URL}
  管理员账号  ${EMAIL}
$( if [[ -n "$admin_pass" ]]; then
     echo "  管理员密码  ${admin_pass}"
     echo "              （只显示这一次。也已存在 ${CONF_DIR}/initial-password，登录后请改掉并删除该文件）"
   else
     echo "  管理员密码  沿用原有密码（本次没有重新生成）"
   fi )

  应用目录    ${APP_DIR}
  配置文件    ${ENV_FILE}
  数据库      postgresql://mailer:***@127.0.0.1:5432/mailer
  备份        每天 03:15 → /var/backups/mailer
$( [[ "$CERT_OK" -eq 1 ]] && echo "  证书        自动续期（每天 03:17 / 15:17 检查）" )

────────────────────────────────────────────
现在必须做的一件事
────────────────────────────────────────────
把 ${ENV_FILE} 另外存一份到密码管理器或离线介质。

里面的 CRED_KEY 是发件账号密码的唯一解密密钥。这台机器如果彻底损坏，
只恢复数据库备份是没用的 —— 没有 CRED_KEY，库里所有 SMTP 密码都解不开。

  sudo cat ${ENV_FILE}

────────────────────────────────────────────
接下来
────────────────────────────────────────────
1. 打开 ${SITE_URL} 登录
2. 到「发件账号」页添加 SMTP 账号（密码用授权码，不是登录密码）
3. 到「联系人」页导入名单
4. 到「邮件模板」页建模板，先发一封测试信给自己
5. 到「群发任务」页建第一个任务

运维手册：docs/运维手册.md
EOF

  if [[ -f "$CONF_DIR/initial-password" ]]; then
    cat <<EOF

登录成功后建议立刻执行，清掉明文密码文件：
  sudo rm -f ${CONF_DIR}/initial-password
EOF
  fi
}

# ---------------------------------------------------------------- 主流程

main() {
  preflight

  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    show_plan
    exit 0
  fi

  echo
  log "开始部署：$TARGET（$( [[ "$MODE" == "ip" ]] && echo IP 直连 || echo 域名 )）"
  echo

  step_provision
  step_reuse_env
  step_align_env
  step_code
  step_build

  # 顺序很重要：先把备份灌进来，再跑迁移。
  # 反过来的话，备份里的旧 schema 会覆盖掉刚建好的新表。
  if [[ -n "$RESTORE_FILE" ]]; then
    step_restore
  fi
  step_db

  step_certbot
  step_nginx_bootstrap
  step_cert
  step_nginx_final
  step_services
  step_verify
  summary
}

main
