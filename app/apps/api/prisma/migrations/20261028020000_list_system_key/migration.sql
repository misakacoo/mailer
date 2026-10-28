-- 系统内置分组：地址不存在（硬退信自动归入）
ALTER TABLE "lists" ADD COLUMN "system_key" TEXT;
CREATE UNIQUE INDEX "lists_system_key_key" ON "lists"("system_key");

-- 已存在的库就地补一条，并把当前抑制名单里仍在联系人表中的地址挪进去
INSERT INTO "lists" ("name", "description", "system_key", "created_at", "updated_at")
SELECT '地址不存在', '硬退信的地址会自动移到这里', 'undeliverable', now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "lists" WHERE "system_key" = 'undeliverable');

INSERT INTO "list_members" ("list_id", "contact_id", "created_at")
SELECT l."id", c."id", now()
FROM "lists" l, "contacts" c
WHERE l."system_key" = 'undeliverable'
  AND c."email" IN (SELECT "email" FROM "suppressions")
ON CONFLICT DO NOTHING;
