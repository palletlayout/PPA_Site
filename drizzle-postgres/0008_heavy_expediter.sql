ALTER TABLE "demand_details" ALTER COLUMN "aiag_serial" SET DEFAULT '';--> statement-breakpoint
ALTER TABLE "demand_details" ADD COLUMN "legacy_expected_serial" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "demand_details" ADD COLUMN "fulfilled_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "demand_details" ADD COLUMN "inventory_item_id" text;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "consumed_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "consumed_at" text;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "weight" double precision;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "unit_cost" double precision;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "receive_date" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "demand_details" ADD CONSTRAINT "demand_details_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "demand_details_inventory_item_idx" ON "demand_details" USING btree ("inventory_item_id");