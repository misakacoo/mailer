#!/usr/bin/env bash
#
# 邮件营销系统 · 迁移导出（在【旧机器】上执行）
#
# 生成一个自包含的迁移包：数据库备份 + 附件 + 关键密钥。
# 拷到新机器后，用 install.sh 一条命令装好并恢复。
#
# 用法：
#   sudo bash deploy/migrate.sh export              # 导出到 /root/mailer-migrate-<时间>.tar.gz
#   sudo bash deploy/migrate.sh export -o /tmp/x.tgz
#   sudo bash deploy/migrate.sh verify <包文件>     # 检查包是否完整
#
set -euo pipefail

CONF_DIR="${CONF_DIR:-/etc/mailer}"
ENV_FILE="$CONF_DIR/mailer.env"
APP_DIR="${APP_DIR:-/opt/mailer}"
DB_NAME="${DB_NAME:-mailer}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m  ✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || die "请用 root 执行"

cmd="${1:-export}"; shift || true

case "$cmd" in
  export)
    OUT=""
    KEEP_RUNNING=0
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -o|--output) OUT="${2:-}"; shift 2 ;;
        --keep-running) KEEP_RUNNING=1; shift ;;
        *) die "未知参数：$1" ;;
      esac
    done
    [[ -f "$ENV_FILE" ]] || die "找不到 $ENV_FILE，这台机器上没装过？"

    STAMP=$(date +%Y%m%d-%H%M%S)
    WORK=$(mktemp -d)
    trap 'rm -rf "$WORK"' EXIT
    OUT="${OUT:-/root/mailer-migrate-$STAMP.tar.gz}"

    log "① 停 worker，保证导出的是静止快照"
    WORKER_WAS_ACTIVE=0
    if systemctl is-active --quiet mailer-worker; then
      WORKER_WAS_ACTIVE=1
      if [[ "$KEEP_RUNNING" -eq 1 ]]; then
        warn "--keep-running：不停 worker，导出的数据可能少最后几秒的写入"
      else
        systemctl stop mailer-worker
        ok "已停止（导出结束会自动拉起）"
      fi
    fi

    restore_worker() {
      if [[ "${WORKER_WAS_ACTIVE:-0}" -eq 1 && "$KEEP_RUNNING" -eq 0 ]]; then
        systemctl start mailer-worker || warn "worker 拉起失败，请手动 systemctl start mailer-worker"
      fi
    }
    trap 'restore_worker; rm -rf "$WORK"' EXIT

    log "② 导出数据库"
    ( cd / && runuser -u postgres -- pg_dump -Fc "$DB_NAME" ) > "$WORK/db.dump"
    SIZE=$(stat -c%s "$WORK/db.dump")
    [[ "$SIZE" -ge 1024 ]] || die "pg_dump 输出异常（${SIZE} 字节）"
    chmod 600 "$WORK/db.dump"
    ok "数据库 $(du -h "$WORK/db.dump" | cut -f1)"

    log "③ 导出附件"
    if [[ -d "$APP_DIR/shared/uploads" ]] && [[ -n "$(ls -A "$APP_DIR/shared/uploads" 2>/dev/null)" ]]; then
      tar -czf "$WORK/uploads.tgz" -C "$APP_DIR/shared" uploads
      ok "附件 $(du -h "$WORK/uploads.tgz" | cut -f1)"
    else
      warn "附件目录为空，跳过"
    fi

    log "④ 导出密钥"
    # 只取迁移真正需要的字段。DATABASE_URL / APP_URL 必须由新机器重新生成，
    # 带过去反而会指向旧地址。
    {
      echo "# 从 $(hostname) 导出，时间 $(date -Iseconds)"
      echo "# 由 install.sh --env-file 读取，只使用下面三项"
      grep -E '^(CRED_KEY|JWT_SECRET|ADMIN_PASSWORD_HASH|ADMIN_EMAIL)=' "$ENV_FILE"
    } > "$WORK/mailer.env"
    chmod 600 "$WORK/mailer.env"
    ok "密钥已提取（CRED_KEY / JWT_SECRET / 管理员密码哈希）"

    grep -qE '^CRED_KEY=[0-9a-fA-F]{64}$' "$WORK/mailer.env" \
      || die "CRED_KEY 格式异常，导出中止 —— 没有它新机器解不开 SMTP 密码"

    cat > "$WORK/README.txt" <<EOF
邮件营销系统 · 迁移包
导出于 $(date -Iseconds)  主机 $(hostname)

包含：
  db.dump        数据库备份（pg_dump -Fc）
  uploads.tgz    附件（可能不存在，表示旧机器没有附件）
  mailer.env     解密密钥与管理员密码哈希

在新机器上执行：
  1. 把整个项目目录和这个包一起上传
  2. sudo bash deploy/install.sh \\
       --ip <新机器IP> \\
       --email <管理员邮箱> \\
       --restore /root/$(basename "$OUT" | sed 's/\.tar\.gz$//')/db.dump \\
       --env-file /root/$(basename "$OUT" | sed 's/\.tar\.gz$//')/mailer.env

  助手会自动把附件一并恢复（同目录下的 uploads.tgz）。

安全提醒：
  mailer.env 里的 CRED_KEY 能解开所有 SMTP 密码。
  迁移完成后请删除这个包：  sudo rm -f $(basename "$OUT")
EOF

    log "⑤ 打包"
    tar -czf "$OUT" -C "$WORK" .
    chmod 600 "$OUT"
    ok "迁移包：$OUT（$(du -h "$OUT" | cut -f1)）"

    echo
    echo "────────────────────────────────────────────"
    echo "下一步"
    echo "────────────────────────────────────────────"
    echo "1) 把项目目录和迁移包一起传到新机器"
    echo "     scp -r <项目目录> root@<新机器IP>:/root/mailer-src"
    echo "     scp $OUT root@<新机器IP>:/root/"
    echo
    echo "2) 在新机器上解包（install.sh 要的是解包后的文件，不是 tar.gz）"
    echo "     sudo bash deploy/migrate.sh verify /root/$(basename "$OUT")   # 可选，先验包"
    echo "     mkdir -p /root/migrate && tar xzf /root/$(basename "$OUT") -C /root/migrate"
    echo
    echo "3) 一条命令装完并恢复数据"
    echo "     cd /root/mailer-src"
    echo "     sudo bash deploy/install.sh --ip <新IP> --email $(
      grep -E '^ADMIN_EMAIL=' "$WORK/mailer.env" | cut -d= -f2- || echo '<邮箱>'
    ) \\"
    echo "       --restore /root/migrate/db.dump \\"
    echo "       --env-file /root/migrate/mailer.env"
    echo
    echo "   附件会自动从 /root/migrate/uploads.tgz 一并恢复（如果有）"
    echo
    warn "确认新机器正常后，删除两端的迁移包（里面有密钥）"
    echo "     sudo rm -rf /root/$(basename "$OUT") /root/migrate"
    ;;

  verify)
    PKG="${1:-}"
    [[ -n "$PKG" ]] || die "用法：migrate.sh verify <包文件>"
    [[ -f "$PKG" ]] || die "文件不存在：$PKG"

    log "检查 $PKG"
    TMP=$(mktemp -d)
    trap 'rm -rf "$TMP"' EXIT
    tar -xzf "$PKG" -C "$TMP" || die "解包失败，文件可能损坏"

    [[ -f "$TMP/db.dump" ]] || die "包里没有 db.dump"
    SZ=$(stat -c%s "$TMP/db.dump")
    [[ "$SZ" -ge 1024 ]] || die "db.dump 只有 ${SZ} 字节，已损坏"
    ok "db.dump $(du -h "$TMP/db.dump" | cut -f1)"

    # 注意：pg_restore -l 只是读归档的目录，不连数据库，
    # 所以这里不需要 runuser 切到 postgres —— 切了反而会被文件权限挡住。
    OBJ=$(pg_restore -l "$TMP/db.dump" 2>/dev/null | grep -c '^[0-9]' || true)
    OBJ="${OBJ:-0}"
    [[ "$OBJ" -ge 5 ]] || die "归档里只有 ${OBJ} 个对象，不完整"
    ok "归档可读：${OBJ} 个对象"

    [[ -f "$TMP/mailer.env" ]] || die "包里没有 mailer.env（缺密钥，导过去也解不开 SMTP 密码）"
    grep -qE '^CRED_KEY=[0-9a-fA-F]{64}$' "$TMP/mailer.env" || die "CRED_KEY 缺失或格式不对"
    ok "密钥完整"

    [[ -f "$TMP/uploads.tgz" ]] && ok "附件 $(
      tar -tzf "$TMP/uploads.tgz" 2>/dev/null | wc -l
    ) 个文件" || warn "没有附件包（旧机器可能没传过附件）"

    echo
    ok "迁移包可用"
    ;;

  *)
    die "未知子命令：$cmd（支持 export / verify）"
    ;;
esac
