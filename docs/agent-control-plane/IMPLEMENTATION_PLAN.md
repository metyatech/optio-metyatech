# Optio Multi-Repo Task & Persistent Cache Architecture Implementation Plan

This document outlines the step-by-step implementation plan for transforming Optio from a single-repository orchestration model to a multi-repo task architecture backed by a persistent repository cache.

## Phase 1: Database Schema Changes (Drizzle)

**Objective:** Transition from flat single-repo columns in the `tasks` table to a 1-to-many relationship using a new `task_repos` table.

1. **Create `task_repos` Schema:**
   - Define a new table `task_repos` in `apps/api/src/db/schema.ts`.
   - **Columns:**
     - `id` (UUID, primary key)
     - `taskId` (UUID, foreign key to `tasks.id`, indexed)
     - `repoUrl` (String, not null)
     - `repoBranch` (String, nullable)
     - `prUrl` (String, nullable)
     - `prNumber` (Integer, nullable)
     - `ciStatus` (Enum/String, default 'none'/'pending')
     - `mergeStatus` (Enum/String, default 'none'/'merged'/'closed')
     - `workspacePath` (String, the localized folder name/path within the task execution pod)
     - `createdAt`, `updatedAt`
2. **Deprecate Single-Repo Columns in `tasks`:**
   - Mark `repoUrl`, `repoBranch`, `prUrl`, `ciStatus`, etc. in `tasks` as deprecated. (Eventually drop them in a follow-up cleanup migration).
   - _Note:_ For backwards compatibility, consider a temporary fallback or data migration script during the deployment phase.
3. **Generate & Apply Migration:**
   - Run `npx drizzle-kit generate` to create the migration (ensure unix-timestamp prefix config is respected).

## Phase 2: API & UI Updates

**Objective:** Support multi-repo task definitions at the creation boundary.

1. **Update API Validations (`apps/api/src/routes/tasks.ts`):**
   - Update the Zod schemas for `POST /api/tasks` to accept `repos: Array<{ url: string, branch?: string, workspacePath?: string }>` instead of top-level `repoUrl` / `repoBranch`.
   - Update the insertion logic in `taskService.createTask` to insert the task and perform a bulk insert into `task_repos`.
2. **Update Task Creation UI (`apps/web/src/app/tasks/new/page.tsx`):**
   - Refactor the repository selection section from a single input to a dynamic list (add/remove repos).
   - Ensure the UI submits the new `repos` array payload.
3. **Update Task Detail Views:**
   - Update the Task execution and PR status UI to iterate over `task_repos` and render a multi-repo status dashboard.

## Phase 3: Persistent Repository Cache Implementation

**Objective:** Replace `git worktree add` with a much faster, fully independent copy from a persistent cache pod/volume.

1. **Modify Pod Provisioning (`scripts/repo-init.sh`):**
   - Update the initialization script to perform a full cache clone to `/workspace/repo-cache`.
   - Add flags to fetch submodules and Git LFS objects: `git clone --mirror` (or full bare clone) plus `git lfs fetch --all`.
2. **Implement Workspace Materialization:**
   - In `repo-pool-service.ts` / `execTaskInRepoPod()`, remove the `git worktree add` command.
   - Replace it with a fast file copy: `cp -a /workspace/repo-cache /workspace/tasks/<taskId>/<workspacePath>`.
   - Reconfigure `.git` logic if using bare clones so the copied directory functions as a normal Git repository.
3. **Cache Invalidation & Updates:**
   - Implement a mechanism to `git fetch origin` in the persistent cache background on a cron/webhook so that new branches and commits are available before copying.

## Phase 4: Task Worker Execution & Materialization

**Objective:** Support running agents across multiple cloned repositories simultaneously.

1. **Multi-Repo Workspace Layout:**
   - Standardize the pod directory structure: `/workspace/tasks/<taskId>/<repo1>`, `/workspace/tasks/<taskId>/<repo2>`.
2. **Update Agent Entrypoint:**
   - Update the execution script to mount or set the working directory to `/workspace/tasks/<taskId>`.
   - Expose environment variables indicating available repositories (e.g., `OPTIO_REPOS_JSON`).
3. **Update `task-worker.ts`:**
   - Iterate over all `task_repos` for the task and orchestrate the `cp -a` commands for each required repository cache before starting the agent process.

## Phase 5: PR & Merge Lifecycle

**Objective:** Ensure CI tracking, reviews, and merges are handled consistently across all repos involved in a task.

1. **Update `pr-watcher-worker.ts`:**
   - Refactor the poll loop to query `task_repos` instead of `tasks`.
   - Aggregate statuses. A task is only "pr*opened" if \_all* relevant repos have PRs opened (or track individual repo states while the parent task stays in "running" until all are ready).
2. **Internal Merge Queue:**
   - Implement logic in the Reconciler to handle atomic merges.
   - Wait for all PRs in `task_repos` to pass CI.
   - Merge them sequentially or concurrently. If one fails to merge (e.g., conflict), gracefully abort and flag the task as requiring attention.
3. **Fail-on-close / Complete-on-merge rules:**
   - Reconciler must evaluate the aggregate state of all `task_repos`.

## Phase 6: Agent-Dotfiles & OpenCode Runtime Adapter

**Objective:** Inject the multi-repo context so the underlying agent (OpenCode, Claude Code) understands its boundaries.

1. **OpenCode Profile Management:**
   - Update the `agent-dotfiles` bootstrap to generate appropriate `.opencode` or agent config files at the root of `/workspace/tasks/<taskId>`.
   - Configure the workspace boundaries so the agent knows it can edit across the defined subdirectories (`repo1`, `repo2`).
2. **Credentials & Git Config:**
   - Loop over `task_repos` to inject appropriate Git credentials and author identities.
   - Ensure the agent's Git operations (commit, push, PR creation) correctly map to the respective directories.

---

_Prepared by Sisyphus-Junior (OhMyOpenCode)_
