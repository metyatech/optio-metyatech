ALTER TABLE "task_repos" ADD COLUMN "merge_order" integer;
ALTER TABLE "task_repos" ADD COLUMN "merge_started_at" timestamp with time zone;
ALTER TABLE "task_repos" ADD COLUMN "merge_completed_at" timestamp with time zone;
ALTER TABLE "task_repos" ADD COLUMN "merge_error" text;
