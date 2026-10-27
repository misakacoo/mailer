-- 移除退订功能
--
-- 1. contacts.unsub_token 不再需要（退订页已下线，链接不再被生成也不再被解析）
-- 2. 历史「已退订」状态归一为 subscribed：界面与统计里不再有退订这个维度
-- 3. 抑制名单里由退订产生的记录**保留不清**——它们仍然表示"不要再发给这个地址"，
--    只是不再由退订页写入。导入与发送都会继续跳过这些地址，避免误发。

-- AlterTable
ALTER TABLE "contacts" DROP COLUMN "unsub_token";

-- 历史状态归一
UPDATE "contacts" SET "status" = 'subscribed' WHERE "status" = 'unsubscribed';
