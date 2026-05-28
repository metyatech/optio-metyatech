ALTER TABLE "task_repos" ADD COLUMN IF NOT EXISTS "pr_opened_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "task_repos" ADD COLUMN IF NOT EXISTS "pr_checks_status_changed_at" timestamp with time zone;
