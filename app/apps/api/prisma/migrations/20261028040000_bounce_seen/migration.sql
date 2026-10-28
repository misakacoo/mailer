-- 退信解析去重：不依赖 IMAP 的 \Seen 标记
CREATE TABLE "bounce_seen" (
    "id" SERIAL NOT NULL,
    "channel_id" INTEGER NOT NULL,
    "uid_validity" BIGINT NOT NULL,
    "uid" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bounce_seen_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bounce_seen_channel_id_uid_validity_uid_key" ON "bounce_seen"("channel_id", "uid_validity", "uid");
CREATE INDEX "bounce_seen_created_at_idx" ON "bounce_seen"("created_at");
