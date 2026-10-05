DROP INDEX "integration_imports_source_content_idx";--> statement-breakpoint
CREATE INDEX "integration_imports_source_content_idx" ON "integration_imports" USING btree ("source","content_hash");