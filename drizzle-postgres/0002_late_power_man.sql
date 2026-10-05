CREATE TABLE "inventory_demand_projections" (
	"id" text PRIMARY KEY NOT NULL,
	"inventory_item_id" text NOT NULL,
	"test_session_id" text NOT NULL,
	"demand_detail_id" text,
	"projection_type" text DEFAULT 'test_demand' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text DEFAULT '' NOT NULL,
	"created_at" text NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" text PRIMARY KEY NOT NULL,
	"capture_session_id" text NOT NULL,
	"source" text DEFAULT 'physical_label' NOT NULL,
	"aiag_serial" text NOT NULL,
	"normalized_serial" text NOT NULL,
	"part_number" text NOT NULL,
	"part_level" text NOT NULL,
	"quantity" integer NOT NULL,
	"raw_aiag_serial" text DEFAULT '' NOT NULL,
	"raw_part_number" text DEFAULT '' NOT NULL,
	"raw_part_level" text DEFAULT '' NOT NULL,
	"raw_quantity" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"is_test" integer DEFAULT 0 NOT NULL,
	"operator_name" text NOT NULL,
	"captured_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_demand_projections" ADD CONSTRAINT "inventory_demand_projections_inventory_item_id_inventory_items_id_fk" FOREIGN KEY ("inventory_item_id") REFERENCES "public"."inventory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_demand_projections" ADD CONSTRAINT "inventory_demand_projections_demand_detail_id_demand_details_id_fk" FOREIGN KEY ("demand_detail_id") REFERENCES "public"."demand_details"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_demand_projections_item_session_idx" ON "inventory_demand_projections" USING btree ("inventory_item_id","test_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_demand_projections_detail_idx" ON "inventory_demand_projections" USING btree ("demand_detail_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_items_serial_idx" ON "inventory_items" USING btree ("normalized_serial");--> statement-breakpoint
CREATE INDEX "inventory_items_lookup_idx" ON "inventory_items" USING btree ("status","part_number","part_level");