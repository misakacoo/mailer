#!/bin/sh
# 容器启动脚本：把"每次启动都要做、且只能做一次"的事收敛在这里。
# 顺序不能乱：密钥 → 数据库迁移 → 管理员初始化 → 交给 CMD。
set -e

DATA_DIR=/data
SECRETS="$DATA_DIR/secrets.env"
mkdir -p "$DATA_DIR/uploads" "$DATA_DIR/tmp"

# ---------- 1. 密钥 ----------
# 存在卷里，且**只在缺失时生成**。重新生成 CRED_KEY 等于库里所有 SMTP 密码永久解不开，
# 这是容器化最容易酿成不可逆事故的一步。
if [ -f "$SECRETS" ]; then
  # shellcheck disable=SC1090
  . "$SECRETS"
  export CRED_KEY JWT_SECRET
fi

need_write=0
if [ -z "${CRED_KEY:-}" ]; then
  CRED_KEY=$(openssl rand -hex 32)
  need_write=1
fi
if [ -z "${JWT_SECRET:-}" ]; then
  JWT_SECRET=$(openssl rand -hex 32)
  need_write=1
fi
export CRED_KEY JWT_SECRET

if [ "$need_write" = "1" ]; then
  # 独占创建：api 与 worker 同时启动时只有一个能写成功。
  # 写失败说明别人刚写好，重新读一次，绝不能各用一套密钥。
  if ( set -C; cat > "$SECRETS" <<EOF
# 自动生成，请勿删除。丢了它，已保存的 SMTP 密码将无法解密。
CRED_KEY=$CRED_KEY
JWT_SECRET=$JWT_SECRET
EOF
  ) 2>/dev/null; then
    chmod 600 "$SECRETS"
    echo "[entrypoint] 已生成凭据密钥并写入 $SECRETS"
  else
    echo "[entrypoint] 密钥文件已被其它进程创建，改为读取现有值"
    # shellcheck disable=SC1090
    . "$SECRETS"
    export CRED_KEY JWT_SECRET
  fi
fi

# ---------- 2. 管理员初始密码 ----------
# 应用启动要求 ADMIN_EMAIL / ADMIN_PASSWORD_HASH 必须存在（它们只在首次写库时用）。
# 这里把明文密码换成哈希，默认 admin/admin，并要求登录后立刻修改。
if [ -z "${ADMIN_EMAIL:-}" ]; then
  ADMIN_EMAIL=admin
  export ADMIN_EMAIL
fi
if [ -z "${ADMIN_PASSWORD_HASH:-}" ]; then
  if [ -z "${ADMIN_PASSWORD:-}" ]; then
    # 没有显式配置就随机生成：默认 admin/admin 会让公网上的面板直接可被接管
    ADMIN_PASSWORD=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)
    export ADMIN_PASSWORD
    echo "[entrypoint] 已生成随机管理员密码（只打印这一次，请立刻保存并登录修改）："
    echo "[entrypoint]   账号：${ADMIN_EMAIL}"
    echo "[entrypoint]   密码：${ADMIN_PASSWORD}"
    ADMIN_FORCE_PASSWORD_CHANGE=1
    export ADMIN_FORCE_PASSWORD_CHANGE
  fi
  ADMIN_PASSWORD_HASH=$(node -e \
    "process.stdout.write(require('/app/apps/api/node_modules/bcryptjs').hashSync(process.env.ADMIN_PASSWORD,12))")
  export ADMIN_PASSWORD_HASH
  # 仍在用弱口令就强制改
  case "$ADMIN_PASSWORD" in
    admin|password|123456|admin123)
      ADMIN_FORCE_PASSWORD_CHANGE=1
      export ADMIN_FORCE_PASSWORD_CHANGE
      ;;
  esac
fi

# ---------- 3. 迁移 ----------
# 只有 api 容器跑（compose 里给 RUN_MIGRATIONS=1），worker 等 api 健康后再起，
# 避免两个进程同时抢 Prisma 的 advisory lock。
if [ "${RUN_MIGRATIONS:-0}" = "1" ]; then
  cd /app/apps/api
  echo "[entrypoint] 应用数据库迁移…"
  i=0
  until ./node_modules/.bin/prisma migrate deploy; do
    i=$((i + 1))
    if [ "$i" -ge 30 ]; then
      echo "[entrypoint] 连续 30 次连不上数据库，放弃启动" >&2
      exit 1
    fi
    echo "[entrypoint] 数据库未就绪，2 秒后重试（$i/30）"
    sleep 2
  done

  echo "[entrypoint] 初始化管理员账号（已存在会跳过）…"
  node dist/scripts/init-admin.js
  cd /app
fi

exec "$@"
