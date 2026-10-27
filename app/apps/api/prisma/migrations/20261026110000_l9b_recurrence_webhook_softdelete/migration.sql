-- L9 增强（第二批）：周期性任务、Webhook 回调、软删除
--
-- 1. campaigns 增加 recurrence 系列字段：任务跑完后由 worker 复制出下一轮，
--    而不是原地重置，这样每一轮的投递记录和统计互不覆盖。
-- 2. campaigns / templates 增加 deleted_at：进回收站而不是立刻物理删除。
-- 3. webhooks / webhook_deliveries：对外回调与投递记录。

-- AlterTable
ALTER TABLE "templates" ADD COLUMN     "deleted_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "recurrence" TEXT,
ADD COLUMN     "recurrence_interval" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "recurrence_until" TIMESTAMP(3),
ADD COLUMN     "series_id" INTEGER;

-- CreateTable
CREATE TABLE "webhooks" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_status" INTEGER,
    "last_error" TEXT,
    "last_fired_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" SERIAL NOT NULL,
    "webhook_id" INTEGER NOT NULL,
    "event" TEXT NOT NULL,
    "status" INTEGER,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_deliveries_webhook_id_id_idx" ON "webhook_deliveries"("webhook_id", "id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_created_at_idx" ON "webhook_deliveries"("created_at");

-- CreateIndex
CREATE INDEX "templates_deleted_at_idx" ON "templates"("deleted_at");

-- CreateIndex
CREATE INDEX "campaigns_series_id_idx" ON "campaigns"("series_id");

-- CreateIndex
CREATE INDEX "campaigns_deleted_at_idx" ON "campaigns"("deleted_at");

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
