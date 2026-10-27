-- 管理员账号移到库里，系统内可改账号与密码。
-- 环境变量的账号密码退化为「首次初始化」用途，之后以本表为准。
CREATE TABLE "admin_account" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_account_pkey" PRIMARY KEY ("id")
);
