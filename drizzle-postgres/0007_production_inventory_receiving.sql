DROP INDEX IF EXISTS "inventory_items_serial_idx";--> statement-breakpoint
ALTER TABLE "inventory_capture_receipts" ADD COLUMN IF NOT EXISTS "is_test" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE "inventory_capture_receipts" SET "is_test" = COALESCE((
  SELECT "is_test" FROM "inventory_items" WHERE "id" = "inventory_item_id"
), "is_test");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_items_scope_serial_idx" ON "inventory_items" USING btree ("is_test","normalized_serial");
