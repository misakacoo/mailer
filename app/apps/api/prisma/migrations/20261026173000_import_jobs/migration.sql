-- 导入任务：大文件导入改为后台分批处理
-- processed_rows 是断点游标；分块处理与游标推进放在同一事务里，
-- 进程崩溃重跑时要么整块生效、要么整块重来，不会重复计数也不会跳行。
-- 状态机：pending → running → done；running ⇄ paused；任意未完成状态 → canceled / failed

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" SERIAL NOT NULL,
    "token" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "ext" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "list_id" INTEGER NOT NULL,
    "mapping" JSONB NOT NULL,
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "processed_rows" INTEGER NOT NULL DEFAULT 0,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "existing" INTEGER NOT NULL DEFAULT 0,
    "added_to_list" INTEGER NOT NULL DEFAULT 0,
    "invalid" INTEGER NOT NULL DEFAULT 0,
    "duplicate_in_file" INTEGER NOT NULL DEFAULT 0,
    "suppressed" INTEGER NOT NULL DEFAULT 0,
    "empty" INTEGER NOT NULL DEFAULT 0,
    "samples" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "import_jobs_token_key" ON "import_jobs"("token");

-- CreateIndex
CREATE INDEX "import_jobs_status_idx" ON "import_jobs"("status");
