CREATE TABLE IF NOT EXISTS "task_repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"repo_url" text NOT NULL,
	"repo_branch" text DEFAULT 'main' NOT NULL,
	"pr_url" text,
	"pr_number" integer,
	"pr_state" text,
	"pr_checks_status" text,
	"pr_review_status" text,
	"ci_status" text,
	"merge_status" text,
	"workspace_path" text,
	"worktree_state" text,
	"pod_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_repos" ADD CONSTRAINT "task_repos_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_repos_task_id_idx" ON "task_repos" USING btree ("task_id");
