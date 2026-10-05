CREATE TABLE "demand_import_rows" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"row_json" text NOT NULL
);
--> statement-breakpoint
DROP INDEX "inventory_items_scope_serial_idx";--> statement-breakpoint
ALTER TABLE "demand_details" ALTER COLUMN "quantity" SET DATA TYPE numeric(20, 6);--> statement-breakpoint
ALTER TABLE "demand_details" ALTER COLUMN "fulfilled_quantity" SET DATA TYPE numeric(20, 6);--> statement-breakpoint
ALTER TABLE "demand_details" ALTER COLUMN "fulfilled_quantity" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "inventory_items" ALTER COLUMN "quantity" SET DATA TYPE numeric(20, 6);--> statement-breakpoint
ALTER TABLE "inventory_items" ALTER COLUMN "consumed_quantity" SET DATA TYPE numeric(20, 6);--> statement-breakpoint
ALTER TABLE "inventory_items" ALTER COLUMN "consumed_quantity" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "demand_details" ADD COLUMN "unit_of_measure" text DEFAULT 'EA' NOT NULL;--> statement-breakpoint
ALTER TABLE "demand_details" ADD COLUMN "source_line_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "demand_details" ADD COLUMN "source_scope" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "demand_details" ADD COLUMN "preferred_supplier_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "demand_headers" ADD COLUMN "dispatched_at" text;--> statement-breakpoint
ALTER TABLE "demand_headers" ADD COLUMN "dispatched_by" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "demand_headers" ADD COLUMN "production_quantity" numeric(20, 6);--> statement-breakpoint
ALTER TABLE "demand_headers" ADD COLUMN "cart_max_quantity" numeric(20, 6);--> statement-breakpoint
ALTER TABLE "demand_headers" ADD COLUMN "interior_color" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "demand_headers" ADD COLUMN "exterior_color" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "demand_headers" ADD COLUMN "vehicle_color" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "supplier_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "unit_of_measure" text DEFAULT 'EA' NOT NULL;--> statement-breakpoint
ALTER TABLE "demand_import_rows" ADD CONSTRAINT "demand_import_rows_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "demand_import_rows_batch_idx" ON "demand_import_rows" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_items_scope_serial_idx" ON "inventory_items" USING btree ("is_test","supplier_id","normalized_serial");