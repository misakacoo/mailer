-- L9：定时发送 + A/B 测试 + 开放 API
-- 1. campaign_variants：一个任务下多套主题/模板，按权重分流
-- 2. recipients.variant：每条投递记录记住自己属于哪个变体，发信时据此覆盖主题与模板
-- 3. api_tokens：开放 API 令牌，只存哈希
-- 4. campaigns(status, scheduled_at) 索引：调度器每 30 秒扫一次"到点该发的任务"

-- AlterTable
ALTER TABLE "recipients" ADD COLUMN     "variant" TEXT;

-- CreateTable
CREATE TABLE "campaign_variants" (
    "id" SERIAL NOT NULL,
    "campaign_id" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "subject" TEXT,
    "template_id" INTEGER,
    "weight" INTEGER NOT NULL DEFAULT 50,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_tokens" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'read',
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "campaign_variants_campaign_id_label_key" ON "campaign_variants"("campaign_id", "label");

-- CreateIndex
CREATE UNIQUE INDEX "api_tokens_prefix_key" ON "api_tokens"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "api_tokens_token_hash_key" ON "api_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "api_tokens_revoked_at_idx" ON "api_tokens"("revoked_at");

-- CreateIndex
CREATE INDEX "campaigns_status_scheduled_at_idx" ON "campaigns"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "recipients_campaign_id_variant_idx" ON "recipients"("campaign_id", "variant");

-- AddForeignKey
ALTER TABLE "campaign_variants" ADD CONSTRAINT "campaign_variants_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
