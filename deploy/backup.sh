#!/usr/bin/env bash
#
# 邮件营销系统 · 每日备份（由 /etc/cron.d/mailer-backup 调用）
# 安装位置：/usr/local/sbin/mailer-backup
#
set -euo pipefail

# cron 的 PATH 只有 /usr/bin:/bin，而 runuser 在 /usr/sbin。
# 只写命令名会在 cron 里报 "runuser: command not found"，重定向又会先建出一个 0 字节的
# .part 文件，配合 set -e 直接中止——表面上"每天都跑过"，实际一份备份都没有。
# 所以这里显式补 PATH，并且用绝对路径调用。
export PATH="/usr/sbin:/usr/local/sbin:$PATH"
RUNUSER="$(command -v runuser || echo /usr/sbin/runuser)"

DB_NAME="${DB_NAME:-mailer}"
UPLOAD_DIR="${UPLOAD_DIR:-/opt/mailer/shared/uploads}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/mailer}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP=$(date +%Y%m%d-%H%M)

mkdir -p "$BACKUP_DIR"
# 组设为 postgres：恢复时 pg_restore 以 postgres 用户运行，读不到文件就等于没备份
chown root:postgres "$BACKUP_DIR" 2>/dev/null || true
chmod 750 "$BACKUP_DIR"

# 数据库用自定义格式：支持 pg_restore 选择性恢复单表
# postgres 用户进不了 /root（700），在 / 下执行
DB_FILE="$BACKUP_DIR/db-$STAMP.dump"
if ! ( cd / && "$RUNUSER" -u postgres -- pg_dump -Fc "$DB_NAME" ) > "$DB_FILE.part"; then
  # 失败要留下人话，并且把半截文件清掉，不要留个 0 字节的 .part 让人误以为是备份
  rm -f "$DB_FILE.part"
  echo "备份失败：pg_dump 未成功，未生成 $DB_FILE" >&2
  exit 1
fi
mv "$DB_FILE.part" "$DB_FILE"
chown root:postgres "$DB_FILE" 2>/dev/null || true
chmod 640 "$DB_FILE"

# 附件与导入临时文件
# 空目录不打包：强行生成会得到一个 100 多字节的空 tar.gz，
# 反而让后面的完整性校验误判成"备份文件异常"。
UPLOADS_FILE="$BACKUP_DIR/uploads-$STAMP.tgz"
if [[ -d "$UPLOAD_DIR" ]] && [[ -n "$(ls -A "$UPLOAD_DIR" 2>/dev/null)" ]]; then
  tar -czf "$UPLOADS_FILE" -C "$(dirname "$UPLOAD_DIR")" uploads
else
  echo "附件目录为空，跳过附件备份"
  UPLOADS_FILE=""
fi

# 数据库 dump 必须有实质内容，空 dump 等于没备
if [[ ! -s "$DB_FILE" ]] || [[ $(stat -c%s "$DB_FILE") -lt 1024 ]]; then
  echo "备份文件异常（疑似为空）：$DB_FILE" >&2
  exit 1
fi
# 附件包只在真的生成了才校验
if [[ -n "$UPLOADS_FILE" && -f "$UPLOADS_FILE" && ! -s "$UPLOADS_FILE" ]]; then
  echo "附件包为空：$UPLOADS_FILE" >&2
  exit 1
fi

find "$BACKUP_DIR" -type f -name 'db-*.dump' -mtime "+$RETENTION_DAYS" -delete
find "$BACKUP_DIR" -type f -name 'uploads-*.tgz' -mtime "+$RETENTION_DAYS" -delete

# 给面板留一个"备份确实跑过"的证据。
# 只看目录里有没有文件是不够的：cron 挂了以后旧文件还在，会误判成备份正常。
if command -v psql >/dev/null 2>&1; then
  STAMP_ISO=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  ( cd / && "$RUNUSER" -u postgres -- psql -d "$DB_NAME" -qc "
      INSERT INTO system_state(key, value, updated_at)
      VALUES ('last_backup_at', '$STAMP_ISO', now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
    " >/dev/null 2>&1 ) || echo "警告：备份成功但未能写入备份心跳" >&2
fi

echo "备份完成：$DB_FILE ($(du -h "$DB_FILE" | cut -f1))"
