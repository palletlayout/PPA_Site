CREATE TABLE "auth_rate_limits" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"window_start" text NOT NULL,
	"expires_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"created_at" text NOT NULL,
	"detail" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cart_locks" ADD COLUMN "operator_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "acquisition_method" text DEFAULT 'legacy_unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "source_file" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "source_import_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "source_row" integer;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "scanned_values_json" text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD COLUMN "recorded_at" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "auth_rate_limits_expiry_idx" ON "auth_rate_limits" USING btree ("expires_at");