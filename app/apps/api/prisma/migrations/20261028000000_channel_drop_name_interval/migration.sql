-- 发件账号页改版：通道不再有名字，也不再有自己的发送间隔。
-- 通道的身份就是它的发信地址（from_email）；发送节奏完全由任务的间隔设置决定，
-- 服务商侧的硬限制由每日配额兜住——两处重复约束只会让人配置时互相打架。
ALTER TABLE "channels" DROP COLUMN "name";
ALTER TABLE "channels" DROP COLUMN "min_interval_sec";
