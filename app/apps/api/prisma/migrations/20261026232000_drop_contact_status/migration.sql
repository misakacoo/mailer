-- 联系人不再有"订阅状态"
--
-- 能不能发只由抑制名单决定（硬退信、投诉、人工拉黑、历史退订记录）：
-- 状态字段既和抑制名单重复，又会出现"标记成已退订但没进名单"的不一致。
-- 抑制名单是唯一真相，联系人表只存身份与自定义字段。

DROP INDEX IF EXISTS "contacts_status_idx";

ALTER TABLE "contacts" DROP COLUMN "status";
