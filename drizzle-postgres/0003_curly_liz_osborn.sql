CREATE TABLE "inventory_capture_receipts" (
	"capture_id" text PRIMARY KEY NOT NULL,
	"capture_session_id" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"inventory_item_id" text,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_capture_receipts" ADD CONSTRAINT "inventory_capture_receipts_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_capture_receipts_item_idx" ON "inventory_capture_receipts" USING btree ("inventory_item_id","created_at");