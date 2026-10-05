CREATE TABLE "cart_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"plant" text NOT NULL,
	"zone" text NOT NULL,
	"area_type" text DEFAULT 'onsite' NOT NULL,
	"ship_category" text NOT NULL,
	"load_number" text NOT NULL,
	"train_number" text NOT NULL,
	"picklist_number" text DEFAULT 'UNASSIGNED' NOT NULL,
	"cart_number" text NOT NULL,
	"cart_id" text DEFAULT 'UNASSIGNED' NOT NULL,
	"pallet_id" text DEFAULT 'UNASSIGNED' NOT NULL,
	"sequence" text NOT NULL,
	"part_number" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"color" text NOT NULL,
	"quantity" integer NOT NULL,
	"aiag_serial" text NOT NULL,
	"master_barcode" text DEFAULT '' NOT NULL,
	"movement_barcode" text DEFAULT '' NOT NULL,
	"case_code" text DEFAULT '' NOT NULL,
	"outgoing_serial" text DEFAULT '' NOT NULL,
	"cart_sequence_number" text DEFAULT '' NOT NULL,
	"from_lot" text DEFAULT '' NOT NULL,
	"to_lot" text DEFAULT '' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"cart_type" text DEFAULT '' NOT NULL,
	"scheduled_dispatch_date" text DEFAULT '' NOT NULL,
	"scheduled_dispatch_time" text DEFAULT '' NOT NULL,
	"delivery_location" text DEFAULT '' NOT NULL,
	"container_position" text DEFAULT '' NOT NULL,
	"container_type" text DEFAULT '' NOT NULL,
	"picking_location" text DEFAULT '' NOT NULL,
	"mcid" text DEFAULT '' NOT NULL,
	"chassis_number" text DEFAULT '' NOT NULL,
	"order_number" text DEFAULT '' NOT NULL,
	"batch_number" text DEFAULT '' NOT NULL,
	"loading_sequence" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verified_at" text
);
--> statement-breakpoint
CREATE TABLE "cart_locks" (
	"cart_key" text PRIMARY KEY NOT NULL,
	"picklist_key" text DEFAULT '' NOT NULL,
	"session_id" text NOT NULL,
	"operator_name" text NOT NULL,
	"acquired_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"inventory_available" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cartflow_schema" (
	"name" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "demand_details" (
	"id" text PRIMARY KEY NOT NULL,
	"header_id" text NOT NULL,
	"sequence" text NOT NULL,
	"part_number" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"color" text NOT NULL,
	"quantity" integer NOT NULL,
	"aiag_serial" text NOT NULL,
	"delivery_location" text DEFAULT '' NOT NULL,
	"container_position" text DEFAULT '' NOT NULL,
	"container_type" text DEFAULT '' NOT NULL,
	"picking_location" text DEFAULT '' NOT NULL,
	"mcid" text DEFAULT '' NOT NULL,
	"container_total" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verified_at" text
);
--> statement-breakpoint
CREATE TABLE "demand_headers" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"cart_key" text NOT NULL,
	"plant" text NOT NULL,
	"zone" text NOT NULL,
	"area_type" text NOT NULL,
	"ship_category" text NOT NULL,
	"load_number" text NOT NULL,
	"train_number" text NOT NULL,
	"picklist_number" text NOT NULL,
	"cart_number" text NOT NULL,
	"cart_id" text NOT NULL,
	"pallet_id" text NOT NULL,
	"cart_barcode" text DEFAULT '' NOT NULL,
	"loaded_at" text,
	"loaded_by" text DEFAULT '' NOT NULL,
	"program_id" text DEFAULT 'ODG303R' NOT NULL,
	"total_carts" integer DEFAULT 0 NOT NULL,
	"pymtc" text DEFAULT '' NOT NULL,
	"checksheet_number" text DEFAULT '' NOT NULL,
	"master_barcode" text DEFAULT '' NOT NULL,
	"movement_barcode" text DEFAULT '' NOT NULL,
	"case_code" text DEFAULT '' NOT NULL,
	"outgoing_serial" text DEFAULT '' NOT NULL,
	"cart_sequence_number" text DEFAULT '' NOT NULL,
	"from_lot" text DEFAULT '' NOT NULL,
	"to_lot" text DEFAULT '' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"cart_type" text DEFAULT '' NOT NULL,
	"scheduled_dispatch_date" text DEFAULT '' NOT NULL,
	"scheduled_dispatch_time" text DEFAULT '' NOT NULL,
	"delivery_location" text DEFAULT '' NOT NULL,
	"chassis_number" text DEFAULT '' NOT NULL,
	"order_number" text DEFAULT '' NOT NULL,
	"batch_number" text DEFAULT '' NOT NULL,
	"loading_sequence" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"file_name" text NOT NULL,
	"row_count" integer NOT NULL,
	"imported_at" text NOT NULL,
	"is_active" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"idempotency_key" text DEFAULT '' NOT NULL,
	"content_hash" text NOT NULL,
	"file_name" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"batch_id" text NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"imported_at" text,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "load_confirmations" (
	"id" text PRIMARY KEY NOT NULL,
	"header_id" text NOT NULL,
	"cart_barcode" text NOT NULL,
	"movement_type" text NOT NULL,
	"movement_number" text NOT NULL,
	"scanned_movement" text NOT NULL,
	"is_test" integer DEFAULT 0 NOT NULL,
	"operator_name" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scan_events" (
	"id" text PRIMARY KEY NOT NULL,
	"line_id" text NOT NULL,
	"cart_key" text NOT NULL,
	"session_id" text DEFAULT '' NOT NULL,
	"field" text NOT NULL,
	"scanned_value" text NOT NULL,
	"matched" integer NOT NULL,
	"is_test" integer DEFAULT 0 NOT NULL,
	"operator_name" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "demand_details" ADD CONSTRAINT "demand_details_header_id_demand_headers_id_fk" FOREIGN KEY ("header_id") REFERENCES "public"."demand_headers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demand_headers" ADD CONSTRAINT "demand_headers_batch_id_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_confirmations" ADD CONSTRAINT "load_confirmations_header_id_demand_headers_id_fk" FOREIGN KEY ("header_id") REFERENCES "public"."demand_headers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cart_lines_work_idx" ON "cart_lines" USING btree ("plant","area_type","picklist_number","cart_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cart_locks_picklist_key_idx" ON "cart_locks" USING btree ("picklist_key") WHERE "cart_locks"."picklist_key" <> '';--> statement-breakpoint
CREATE INDEX "demand_details_header_status_idx" ON "demand_details" USING btree ("header_id","status","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "demand_headers_batch_cart_idx" ON "demand_headers" USING btree ("batch_id","cart_key");--> statement-breakpoint
CREATE UNIQUE INDEX "demand_headers_cart_barcode_idx" ON "demand_headers" USING btree ("cart_barcode");--> statement-breakpoint
CREATE INDEX "demand_headers_work_idx" ON "demand_headers" USING btree ("batch_id","plant","area_type","picklist_number","cart_id");--> statement-breakpoint
CREATE INDEX "import_batches_imported_idx" ON "import_batches" USING btree ("imported_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_batches_one_active_idx" ON "import_batches" USING btree ("is_active") WHERE "import_batches"."is_active" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_imports_source_content_idx" ON "integration_imports" USING btree ("source","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_imports_source_key_idx" ON "integration_imports" USING btree ("source","idempotency_key") WHERE "integration_imports"."idempotency_key" <> '';--> statement-breakpoint
CREATE INDEX "integration_imports_status_expiry_idx" ON "integration_imports" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "load_confirmations_header_idx" ON "load_confirmations" USING btree ("header_id");--> statement-breakpoint
CREATE INDEX "load_confirmations_created_idx" ON "load_confirmations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "scan_events_created_idx" ON "scan_events" USING btree ("created_at");