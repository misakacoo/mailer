-- 安全与性能修复：会话版本、发送租约、保留投递历史、补索引

-- 1) 管理员会话版本（登出/改密后旧令牌失效）
ALTER TABLE "admin_account" ADD COLUMN IF NOT EXISTS "token_version" INTEGER NOT NULL DEFAULT 0;

-- 2) 发送租约：到期未完成才允许回收，避免把在途邮件当僵尸重投
ALTER TABLE "recipients" ADD COLUMN IF NOT EXISTS "lease_until" TIMESTAMP(3);

-- 3) 联系人被删后保留投递历史：contact_id 改可空 + ON DELETE SET NULL
ALTER TABLE "recipients" DROP CONSTRAINT IF EXISTS "recipients_contact_id_fkey";
ALTER TABLE "recipients" ALTER COLUMN "contact_id" DROP NOT NULL;
ALTER TABLE "recipients"
  ADD CONSTRAINT "recipients_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "contacts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "events" DROP CONSTRAINT IF EXISTS "events_contact_id_fkey";
ALTER TABLE "events" ALTER COLUMN "contact_id" DROP NOT NULL;
ALTER TABLE "events"
  ADD CONSTRAINT "events_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "contacts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 4) 统计查询需要的索引（概览按 sent_at / opened_at / clicked_at 过滤）
CREATE INDEX IF NOT EXISTS "recipients_sent_at_idx" ON "recipients"("sent_at");
CREATE INDEX IF NOT EXISTS "recipients_opened_at_idx" ON "recipients"("opened_at");
CREATE INDEX IF NOT EXISTS "recipients_clicked_at_idx" ON "recipients"("clicked_at");
CREATE INDEX IF NOT EXISTS "recipients_status_updated_at_idx" ON "recipients"("status", "updated_at");
CREATE INDEX IF NOT EXISTS "events_created_at_idx" ON "events"("created_at");

-- 5) 周期任务：同一系列同一时刻只能有一条（兜住多 worker 的重复生成）
CREATE UNIQUE INDEX IF NOT EXISTS "campaigns_series_id_scheduled_at_key"
  ON "campaigns"("series_id", "scheduled_at");

-- 6) 清掉没有查询使用的索引（纯写放大）
DROP INDEX IF EXISTS "contacts_created_at_idx";
DROP INDEX IF EXISTS "suppressions_reason_idx";
