ALTER TABLE "fulfillment_settings" ADD COLUMN IF NOT EXISTS "part_attribute" text DEFAULT 'color_or_part_level' NOT NULL;
