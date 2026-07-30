CREATE TABLE "records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"happened_at" timestamp with time zone NOT NULL,
	"value_numeric" numeric,
	"value_text" text,
	"tags" text NOT NULL,
	"objective_context" text NOT NULL,
	"subjective_interpretation" text,
	CONSTRAINT "chk_value" CHECK ("records"."value_numeric" IS NOT NULL OR "records"."value_text" IS NOT NULL),
	CONSTRAINT "chk_tags" CHECK ("records"."tags" ~ '^\[.+\]$')
);
