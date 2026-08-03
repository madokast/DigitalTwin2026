CREATE TABLE "records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"happened_at" timestamp with time zone NOT NULL,
	"utc_offset" text NOT NULL,
	"value_number" text,
	"value_text" text,
	"tags" text NOT NULL,
	"objective_context" text NOT NULL,
	"subjective_interpretation" text,
	CONSTRAINT "chk_value" CHECK ("records"."value_number" IS NOT NULL OR "records"."value_text" IS NOT NULL),
	CONSTRAINT "chk_tags" CHECK ("records"."tags" ~ '^\[.+\]$'),
	CONSTRAINT "chk_utc_offset" CHECK ("records"."utc_offset" = 'Z' OR "records"."utc_offset" ~ '^[+-][0-9]{2}:[0-9]{2}$')
);
