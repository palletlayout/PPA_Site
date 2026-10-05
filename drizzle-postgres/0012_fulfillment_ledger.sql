CREATE TABLE "fulfillment_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"demand_detail_id" text NOT NULL,
	"inventory_item_id" text NOT NULL,
	"quantity" numeric(20, 6) NOT NULL,
	"serial" text NOT NULL,
	"packed_at" text NOT NULL,
	"packed_by" text NOT NULL,
	"operator_id" text DEFAULT '' NOT NULL,
	"reversed_at" text,
	"reversed_by" text DEFAULT '' NOT NULL,
	CONSTRAINT "fulfillment_allocations_request_id_unique" UNIQUE("request_id"),
	CONSTRAINT "fulfillment_allocations_positive_quantity" CHECK ("fulfillment_allocations"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "fulfillment_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"packing_mode" text NOT NULL,
	"inventory_mode" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" text DEFAULT '' NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
DROP INDEX "demand_details_inventory_item_idx";--> statement-breakpoint
ALTER TABLE "demand_details" ADD COLUMN "pack_sequence" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "demand_details" ADD COLUMN "fulfilled_at" text;--> statement-breakpoint
ALTER TABLE "demand_details" ADD COLUMN "fulfilled_by" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "demand_headers" ADD COLUMN "option_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "demand_headers" ADD COLUMN "short_closed_at" text;--> statement-breakpoint
ALTER TABLE "fulfillment_allocations" ADD CONSTRAINT "fulfillment_allocations_demand_detail_id_demand_details_id_fk" FOREIGN KEY ("demand_detail_id") REFERENCES "public"."demand_details"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fulfillment_allocations" ADD CONSTRAINT "fulfillment_allocations_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fulfillment_allocations_detail_idx" ON "fulfillment_allocations" USING btree ("demand_detail_id","reversed_at");--> statement-breakpoint
CREATE INDEX "fulfillment_allocations_inventory_idx" ON "fulfillment_allocations" USING btree ("inventory_item_id","reversed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fulfillment_allocations_active_pair_idx" ON "fulfillment_allocations" USING btree ("demand_detail_id","inventory_item_id") WHERE "fulfillment_allocations"."reversed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "demand_details_inventory_item_lookup_idx" ON "demand_details" USING btree ("inventory_item_id");--> statement-breakpoint
INSERT INTO fulfillment_settings (id, packing_mode, inventory_mode)
VALUES ('primary', 'exact', 'uploaded') ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO fulfillment_allocations (id, request_id, request_fingerprint,
  demand_detail_id, inventory_item_id, quantity, serial, packed_at, packed_by, operator_id)
SELECT 'legacy:' || d.id, 'legacy:' || d.id, 'legacy', d.id, d.inventory_item_id,
  d.fulfilled_quantity, COALESCE(NULLIF(d.aiag_serial, ''), i.aiag_serial),
  COALESCE(d.verified_at, i.consumed_at, i.captured_at),
  COALESCE((SELECT e.operator_name FROM scan_events e WHERE e.line_id=d.id AND e.field='aiagSerial' AND e.matched=1 ORDER BY e.created_at DESC LIMIT 1), ''),
  COALESCE((SELECT e.operator_id FROM scan_events e WHERE e.line_id=d.id AND e.field='aiagSerial' AND e.matched=1 ORDER BY e.created_at DESC LIMIT 1), '')
FROM demand_details d JOIN inventory_items i ON i.id=d.inventory_item_id
WHERE d.fulfilled_quantity>0 AND NOT EXISTS (SELECT 1 FROM fulfillment_allocations a WHERE a.demand_detail_id=d.id)
ON CONFLICT DO NOTHING;
