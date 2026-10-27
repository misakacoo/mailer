-- 发件账号分组
--
-- 业务上要按「分组」选号而不是逐条挑通道：
-- 一个账号下常有多条通道（不同 fromName），任务只关心用哪一批账号。
-- campaigns.channel_group_ids 非空时优先按分组解析；为空则退回 channel_ids / 自动分配，
-- 这样老任务与旧接口不受影响。

-- AlterTable
ALTER TABLE "channels" ADD COLUMN     "group_id" INTEGER;

-- AlterTable
ALTER TABLE "campaigns" ADD COLUMN     "channel_group_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- CreateTable
CREATE TABLE "channel_groups" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channel_groups_name_key" ON "channel_groups"("name");

-- CreateIndex
CREATE INDEX "channels_group_id_idx" ON "channels"("group_id");

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "channel_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
