-- 第五批：
-- 1. 删除开放 API（api_tokens）与 Webhook（webhooks / webhook_deliveries）
-- 2. 发件通道由「归属一个分组」改为「可归多个分组」：group_id → group_ids 数组
-- 3. 任务发送间隔支持随机区间：新增 send_interval_max_sec

-- 1) 开放 API / Webhook 相关表整体下线
DROP TABLE IF EXISTS "webhook_deliveries";
DROP TABLE IF EXISTS "webhooks";
DROP TABLE IF EXISTS "api_tokens";

-- 2) 通道多分组
ALTER TABLE "channels" ADD COLUMN "group_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
-- 已有的单一分组平移到数组里，不丢归属
UPDATE "channels" SET "group_ids" = ARRAY["group_id"] WHERE "group_id" IS NOT NULL;
ALTER TABLE "channels" DROP COLUMN "group_id";

-- 3) 随机发送间隔（最小间隔复用 send_interval_sec）
ALTER TABLE "campaigns" ADD COLUMN "send_interval_max_sec" INTEGER;
