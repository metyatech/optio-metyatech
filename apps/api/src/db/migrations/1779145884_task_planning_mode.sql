ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "planning_mode_enabled" boolean DEFAULT false NOT NULL;
ALTER TABLE "task_configs" ADD COLUMN IF NOT EXISTS "planning_mode_enabled" boolean DEFAULT false NOT NULL;
