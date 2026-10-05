CREATE TABLE "raw_capture_scans" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"position" integer NOT NULL,
	"raw_value" text NOT NULL,
	"scanned_at" text NOT NULL,
	"saved_at" text NOT NULL,
	"operator_id" text NOT NULL,
	"operator_name" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "raw_capture_owner_session_idx" ON "raw_capture_scans" USING btree ("operator_id","session_id","position");