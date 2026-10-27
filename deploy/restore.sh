#!/usr/bin/env bash
#
# 邮件营销系统 · 备份恢复
# 安装位置：/usr/local/sbin/mailer-restore
#
# 默认是「演练」：恢复到临时库、核对数据、然后删掉，不碰生产库。
# 加 --live 才真正恢复，且会先把当前生产库备份一份。
#
# 用法：
#   mailer-restore                          # 用最新的备份演练
#   mailer-restore /var/backups/mailer/db-20261026-0315.dump
#   mailer-restore --live <file>            # 正式恢复（需先停服务）
#
set -euo pipefail

# 与 backup.sh 同样的原因：runuser 在 /usr/sbin，别处调起时 PATH 未必包含它
export PATH="/usr/sbin:/usr/local/sbin:$PATH"
RUNUSER="$(command -v runuser || echo /usr/sbin/runuser)"

DB_NAME="${DB_NAME:-mailer}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/mailer}"
TEST_DB="${DB_NAME}_restore_test"

MODE="drill"
FILE=""
for arg in "$@"; do
  case "$arg" in
    --live) MODE="live" ;;
    -h|--help) sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) FILE="$arg" ;;
  esac
done

psql_as_pg() { ( cd / && "$RUNUSER" -u postgres -- psql -tAc "$1" ); }

if [[ -z "$FILE" ]]; then
  FILE=$(ls -1t "$BACKUP_DIR"/db-*.dump 2>/dev/null | head -1 || true)
  [[ -n "$FILE" ]] || { echo "错误：$BACKUP_DIR 下找不到任何备份文件" >&2; exit 1; }
  echo "使用最新备份：$FILE"
fi

[[ -f "$FILE" ]] || { echo "错误：备份文件不存在：$FILE" >&2; exit 1; }
SIZE=$(stat -c%s "$FILE")
[[ "$SIZE" -ge 1024 ]] || { echo "错误：备份文件过小（${SIZE} 字节），疑似损坏" >&2; exit 1; }
echo "备份文件：$FILE（$(du -h "$FILE" | cut -f1)）"

# pg_restore 以 postgres 用户运行，而它未必能读到备份文件：
# 目录 700（/root、临时目录）时改文件权限没用，必须先把文件搬到它能进的地方。
if ! "$RUNUSER" -u postgres -- test -r "$FILE" 2>/dev/null; then
  STAGING_DIR="/var/backups/mailer"
  install -d -m 750 -o root -g postgres "$STAGING_DIR"
  STAGED="$STAGING_DIR/_restore-$(date +%s).dump"
  cp -f "$FILE" "$STAGED"
  chown root:postgres "$STAGED" 2>/dev/null || true
  chmod 640 "$STAGED"
  if "$RUNUSER" -u postgres -- test -r "$STAGED" 2>/dev/null; then
    echo "提示：原文件所在目录 postgres 无法访问，已复制到 $STAGED"
    FILE="$STAGED"
    CLEAN_STAGED=1
  else
    echo "错误：无法让 postgres 读取备份文件（$FILE）" >&2
    exit 1
  fi
fi

cleanup_staged() {
  if [[ "${CLEAN_STAGED:-0}" -eq 1 && -n "${STAGED:-}" && -f "$STAGED" ]]; then
    rm -f "$STAGED"
  fi
}
trap cleanup_staged EXIT

echo
echo "== 1. 校验归档完整性 =="
OBJECTS=$( ( cd / && "$RUNUSER" -u postgres -- pg_restore -l "$FILE" ) | grep -c '^[0-9]' || true )
if [[ "$OBJECTS" -lt 5 ]]; then
  echo "错误：归档里只有 ${OBJECTS} 个对象，明显不完整" >&2
  exit 1
fi
echo "归档包含 ${OBJECTS} 个对象，结构可读"

if [[ "$MODE" == "live" ]]; then
  echo
  echo "== 正式恢复模式 =="
  echo "这会覆盖生产库 $DB_NAME，并断开所有连接。"
  echo "建议先执行：systemctl stop mailer-api mailer-worker"
  read -r -p "确认继续？输入 yes 继续：" ans
  [[ "$ans" == "yes" ]] || { echo "已取消"; exit 1; }

  SAFETY="$BACKUP_DIR/pre-restore-$(date +%Y%m%d-%H%M%S).dump"
  echo "先备份当前生产库到 $SAFETY"
  ( cd / && "$RUNUSER" -u postgres -- pg_dump -Fc "$DB_NAME" ) > "$SAFETY"

  echo "断开现有连接并重建数据库"
  psql_as_pg "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB_NAME' AND pid <> pg_backend_pid()" >/dev/null
  ( cd / && "$RUNUSER" -u postgres -- dropdb --if-exists "$DB_NAME" )
  ( cd / && "$RUNUSER" -u postgres -- createdb -O "$DB_NAME" "$DB_NAME" )

  echo "恢复中…"
  ( cd / && "$RUNUSER" -u postgres -- pg_restore --no-owner --no-privileges -d "$DB_NAME" "$FILE" ) 2>&1 | tail -5

  TABLES=$(psql_as_pg "select count(*) from information_schema.tables where table_schema='public'" | tr -d ' ')
  CONTACTS=$(psql_as_pg "select count(*) from contacts" | tr -d ' ')
  echo
  echo "恢复完成：${TABLES} 张表，${CONTACTS} 个联系人"
  echo "回滚方式：pg_restore -d $DB_NAME $SAFETY"
  echo "然后：systemctl start mailer-api mailer-worker"
  exit 0
fi

echo
echo "== 2. 恢复到临时库 $TEST_DB =="
( cd / && "$RUNUSER" -u postgres -- dropdb --if-exists "$TEST_DB" )
( cd / && "$RUNUSER" -u postgres -- createdb -O "$DB_NAME" "$TEST_DB" )
( cd / && "$RUNUSER" -u postgres -- pg_restore --no-owner --no-privileges -d "$TEST_DB" "$FILE" ) 2>&1 | tail -3 || true

echo
echo "== 3. 核对恢复结果 =="
Q() { ( cd / && "$RUNUSER" -u postgres -- psql -tAc "$1" -d "$TEST_DB" 2>/dev/null | tr -d ' ' ); }
TABLES=$(Q "select count(*) from information_schema.tables where table_schema='public'")
CONTACTS=$(Q "select count(*) from contacts")
CHANNELS=$(Q "select count(*) from channels")
CAMPAIGNS=$(Q "select count(*) from campaigns")
RECIPIENTS=$(Q "select count(*) from recipients")
SUPPRESS=$(Q "select count(*) from suppressions")

printf '  %-16s %s\n' "表数量" "${TABLES:-0}"
printf '  %-16s %s\n' "联系人" "${CONTACTS:-0}"
printf '  %-16s %s\n' "发件账号" "${CHANNELS:-0}"
printf '  %-16s %s\n' "群发任务" "${CAMPAIGNS:-0}"
printf '  %-16s %s\n' "投递明细" "${RECIPIENTS:-0}"
printf '  %-16s %s\n' "抑制名单" "${SUPPRESS:-0}"

echo
echo "== 4. 清理临时库 =="
( cd / && "$RUNUSER" -u postgres -- dropdb --if-exists "$TEST_DB" )

if [[ "${TABLES:-0}" -lt 8 ]]; then
  echo "结果：恢复出来的表少于预期（${TABLES}），这份备份可能有问题" >&2
  exit 1
fi
echo "结果：演练通过，这份备份可以用于恢复"
