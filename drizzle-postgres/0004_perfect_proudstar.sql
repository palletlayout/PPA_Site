CREATE TABLE "cartflow_write_guards" (
	"id" text PRIMARY KEY NOT NULL,
	"valid" integer NOT NULL,
	CONSTRAINT "cartflow_write_guard_valid" CHECK ("cartflow_write_guards"."valid" = 1)
);
--> statement-breakpoint
CREATE TABLE "demand_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"header_id" text NOT NULL,
	"line_id" text NOT NULL,
	"action" text NOT NULL,
	"before_json" text NOT NULL,
	"after_json" text NOT NULL,
	"actor_id" text DEFAULT '' NOT NULL,
	"actor_name" text DEFAULT '' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cart_locks" ADD COLUMN "lease_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "demand_details" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "demand_headers" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "load_confirmations" ADD COLUMN "operator_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_events" ADD COLUMN "operator_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_events" ADD COLUMN "lease_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "scan_events" ADD COLUMN "invalidated_at" text;--> statement-breakpoint
CREATE INDEX "demand_audit_events_batch_idx" ON "demand_audit_events" USING btree ("batch_id","created_at");--> statement-breakpoint
CREATE INDEX "scan_events_evidence_idx" ON "scan_events" USING btree ("line_id","session_id","is_test","invalidated_at","created_at");