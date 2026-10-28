-- 删除 A/B 测试：变体表与收件人上的变体标签列
DROP TABLE IF EXISTS "campaign_variants";

DROP INDEX IF EXISTS "recipients_campaign_id_variant_idx";
ALTER TABLE "recipients" DROP COLUMN IF EXISTS "variant";
