import { describe, it, expect, vi, beforeEach } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  getRepoByUrl: vi.fn(),
  getGitPlatformForRepo: vi.fn(),
  enqueueReconcile: vi.fn(),
}));

// Mock dependencies before importing the service
vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../db/schema.js", () => ({
  tasks: {
    id: "tasks.id",
    parentTaskId: "tasks.parent_task_id",
    subtaskOrder: "tasks.subtask_order",
    blocksParent: "tasks.blocks_parent",
    state: "tasks.state",
    taskType: "tasks.task_type",
    repoUrl: "tasks.repo_url",
    prUrl: "tasks.pr_url",
    prNumber: "tasks.pr_number",
    prState: "tasks.pr_state",
    prChecksStatus: "tasks.pr_checks_status",
    prReviewStatus: "tasks.pr_review_status",
    prReviewComments: "tasks.pr_review_comments",
    updatedAt: "tasks.updated_at",
  },
  taskRepos: {
    id: "task_repos.id",
    taskId: "task_repos.task_id",
    prUrl: "task_repos.pr_url",
    prNumber: "task_repos.pr_number",
    prState: "task_repos.pr_state",
    prChecksStatus: "task_repos.pr_checks_status",
    ciStatus: "task_repos.ci_status",
    prReviewStatus: "task_repos.pr_review_status",
    updatedAt: "task_repos.updated_at",
  },
  repos: {
    repoUrl: "repos.repo_url",
    workspaceId: "repos.workspace_id",
  },
  workspaces: {
    id: "workspaces.id",
    slug: "workspaces.slug",
  },
}));

vi.mock("./task-service.js", () => ({
  getTask: vi.fn(),
  createTask: vi.fn(),
  transitionTask: vi.fn(),
  StateRaceError: class StateRaceError extends Error {
    constructor(
      public readonly attemptedFrom: string,
      public readonly attemptedTo: string,
      public readonly actualState: string | undefined,
    ) {
      super(`State race: expected ${attemptedFrom} → ${attemptedTo}`);
      this.name = "StateRaceError";
    }
  },
}));

vi.mock("../workers/task-worker.js", () => ({
  taskQueue: {
    add: vi.fn(),
  },
}));

vi.mock("./repo-service.js", () => ({
  getRepoByUrl: serviceMocks.getRepoByUrl,
}));

vi.mock("./git-token-service.js", () => ({
  getGitPlatformForRepo: serviceMocks.getGitPlatformForRepo,
}));

vi.mock("./reconcile-queue.js", () => ({
  enqueueReconcile: serviceMocks.enqueueReconcile,
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

import { db } from "../db/client.js";
import * as taskService from "./task-service.js";
import { taskQueue } from "../workers/task-worker.js";
import {
  createSubtask,
  queueSubtask,
  getSubtasks,
  checkBlockingSubtasks,
  onSubtaskComplete,
  getPipelineProgress,
} from "./subtask-service.js";

function mockCompletedReviewSubtaskQueries() {
  let selectCallCount = 0;
  (db.select as any) = vi.fn().mockImplementation(() => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(() => {
        selectCallCount++;
        if (selectCallCount === 1) {
          return Promise.resolve([{ id: "review-1", state: "completed", blocksParent: true }]);
        }
        if (selectCallCount === 2) {
          return Promise.resolve([{ id: "review-1", state: "completed", taskType: "review" }]);
        }
        return Promise.resolve([]);
      }),
    }),
  }));
}

function mockDbUpdates() {
  (db.update as any) = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  });
}

function mockObservedPr(opts: {
  prNumber?: number;
  reviews?: { state: string; body?: string }[];
  checks?: { status: string; conclusion: string | null }[];
  mergeable?: boolean | null;
  merged?: boolean;
  prState?: "open" | "closed";
}) {
  const mergePullRequest = vi.fn().mockResolvedValue(undefined);
  serviceMocks.getGitPlatformForRepo.mockResolvedValue({
    platform: {
      getPullRequest: vi.fn().mockResolvedValue({
        number: opts.prNumber ?? 42,
        state: opts.prState ?? "open",
        merged: opts.merged ?? false,
        mergeable: opts.mergeable ?? true,
        headSha: "sha-1",
      }),
      getCIChecks: vi
        .fn()
        .mockResolvedValue(opts.checks ?? [{ status: "completed", conclusion: "success" }]),
      getReviews: vi.fn().mockResolvedValue(opts.reviews ?? [{ state: "APPROVED", body: "LGTM" }]),
      mergePullRequest,
    },
    ri: {
      platform: "github",
      host: "github.com",
      owner: "owner",
      repo: "repo",
      apiBaseUrl: "https://api.github.com",
    },
  });
  return mergePullRequest;
}

describe("subtask-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.getRepoByUrl.mockReset();
    serviceMocks.getGitPlatformForRepo.mockReset();
    serviceMocks.enqueueReconcile.mockReset();
  });

  describe("createSubtask", () => {
    it("creates a subtask linked to parent", async () => {
      const parent = {
        id: "parent-1",
        title: "Parent task",
        repoUrl: "https://github.com/owner/repo",
        agentType: "claude-code",
        priority: 100,
      };
      const createdTask = { ...parent, id: "subtask-1" };

      vi.mocked(taskService.getTask).mockResolvedValue(parent as any);
      vi.mocked(taskService.createTask).mockResolvedValue(createdTask as any);

      // Mock max subtask order query
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ max: -1 }]),
        }),
      });

      // Mock the update for subtask fields
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const result = await createSubtask({
        parentTaskId: "parent-1",
        title: "Child task",
        prompt: "Do something",
      });

      expect(taskService.getTask).toHaveBeenCalledWith("parent-1");
      expect(taskService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Child task",
          prompt: "Do something",
          repoUrl: "https://github.com/owner/repo",
          agentType: "claude-code",
          priority: 99, // parent priority (100) - 1
        }),
      );
      expect(result.parentTaskId).toBe("parent-1");
      expect(result.subtaskOrder).toBe(0); // -1 + 1 = 0
    });

    it("throws when parent task is not found", async () => {
      vi.mocked(taskService.getTask).mockResolvedValue(null as any);

      await expect(
        createSubtask({
          parentTaskId: "nonexistent",
          title: "Child",
          prompt: "Do stuff",
        }),
      ).rejects.toThrow("Parent task not found");
    });

    it("uses provided taskType and blocksParent", async () => {
      const parent = {
        id: "parent-1",
        repoUrl: "https://github.com/owner/repo",
        agentType: "claude-code",
        priority: 50,
      };
      vi.mocked(taskService.getTask).mockResolvedValue(parent as any);
      vi.mocked(taskService.createTask).mockResolvedValue({ id: "sub-1" } as any);

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ max: 2 }]),
        }),
      });

      let capturedSet: any;
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((vals: any) => {
          capturedSet = vals;
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      });

      await createSubtask({
        parentTaskId: "parent-1",
        title: "Review task",
        prompt: "Review PR",
        taskType: "review",
        blocksParent: true,
      });

      expect(capturedSet.taskType).toBe("review");
      expect(capturedSet.blocksParent).toBe(true);
      expect(capturedSet.subtaskOrder).toBe(3); // max(2) + 1
    });

    it("overrides agent type when provided", async () => {
      const parent = {
        id: "p-1",
        repoUrl: "https://github.com/owner/repo",
        agentType: "codex",
        priority: 100,
      };
      vi.mocked(taskService.getTask).mockResolvedValue(parent as any);
      vi.mocked(taskService.createTask).mockResolvedValue({ id: "s-1" } as any);

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ max: -1 }]),
        }),
      });
      (db.update as any) = vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      await createSubtask({
        parentTaskId: "p-1",
        title: "Task",
        prompt: "Do it",
        agentType: "claude-code",
      });

      expect(taskService.createTask).toHaveBeenCalledWith(
        expect.objectContaining({ agentType: "claude-code" }),
      );
    });
  });

  describe("queueSubtask", () => {
    it("transitions subtask to queued and adds to queue", async () => {
      vi.mocked(taskService.getTask).mockResolvedValue({
        id: "sub-1",
        priority: 50,
        maxRetries: 3,
      } as any);

      await queueSubtask("sub-1");

      expect(taskService.transitionTask).toHaveBeenCalledWith("sub-1", "queued", "subtask_queued");
      expect(taskQueue.add).toHaveBeenCalledWith(
        "process-task",
        { taskId: "sub-1" },
        expect.objectContaining({
          jobId: "sub-1",
          priority: 50,
          attempts: 4, // maxRetries(3) + 1
          backoff: { type: "exponential", delay: 5000 },
        }),
      );
    });

    it("throws when subtask is not found", async () => {
      vi.mocked(taskService.getTask).mockResolvedValue(null as any);

      await expect(queueSubtask("nonexistent")).rejects.toThrow("Subtask not found");
    });
  });

  describe("getSubtasks", () => {
    it("queries subtasks by parentTaskId ordered by subtaskOrder", async () => {
      const mockSubtasks = [
        { id: "s-1", subtaskOrder: 0 },
        { id: "s-2", subtaskOrder: 1 },
      ];

      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(mockSubtasks),
          }),
        }),
      });

      const result = await getSubtasks("parent-1");
      expect(result).toEqual(mockSubtasks);
    });
  });

  describe("checkBlockingSubtasks", () => {
    it("returns allComplete true when no blocking subtasks exist", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await checkBlockingSubtasks("parent-1");
      expect(result).toEqual({
        allComplete: true,
        total: 0,
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
      });
    });

    it("returns allComplete true when all blocking subtasks are completed", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: "s-1", state: "completed", blocksParent: true },
            { id: "s-2", state: "completed", blocksParent: true },
          ]),
        }),
      });

      const result = await checkBlockingSubtasks("parent-1");
      expect(result).toEqual({
        allComplete: true,
        total: 2,
        pending: 0,
        running: 0,
        completed: 2,
        failed: 0,
      });
    });

    it("returns allComplete false when some subtasks are still running", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: "s-1", state: "completed", blocksParent: true },
            { id: "s-2", state: "running", blocksParent: true },
          ]),
        }),
      });

      const result = await checkBlockingSubtasks("parent-1");
      expect(result).toEqual({
        allComplete: false,
        total: 2,
        pending: 0,
        running: 1,
        completed: 1,
        failed: 0,
      });
    });

    it("counts provisioning and queued as running", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: "s-1", state: "provisioning", blocksParent: true },
            { id: "s-2", state: "queued", blocksParent: true },
            { id: "s-3", state: "completed", blocksParent: true },
          ]),
        }),
      });

      const result = await checkBlockingSubtasks("parent-1");
      expect(result).toEqual({
        allComplete: false,
        total: 3,
        pending: 0,
        running: 2,
        completed: 1,
        failed: 0,
      });
    });

    it("counts failed subtasks correctly", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: "s-1", state: "completed", blocksParent: true },
            { id: "s-2", state: "failed", blocksParent: true },
          ]),
        }),
      });

      const result = await checkBlockingSubtasks("parent-1");
      expect(result).toEqual({
        allComplete: false,
        total: 2,
        pending: 0,
        running: 0,
        completed: 1,
        failed: 1,
      });
    });

    it("counts pending subtasks", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "s-1", state: "pending", blocksParent: true }]),
        }),
      });

      const result = await checkBlockingSubtasks("parent-1");
      expect(result).toEqual({
        allComplete: false,
        total: 1,
        pending: 1,
        running: 0,
        completed: 0,
        failed: 0,
      });
    });
  });

  describe("onSubtaskComplete", () => {
    it("does nothing when subtask has no parent", async () => {
      vi.mocked(taskService.getTask).mockResolvedValue({
        id: "s-1",
        parentTaskId: null,
      } as any);

      await onSubtaskComplete("s-1");

      // getTask only called once (for the subtask), no further processing
      expect(taskService.getTask).toHaveBeenCalledTimes(1);
    });

    it("does nothing when not all blocking subtasks are complete", async () => {
      vi.mocked(taskService.getTask).mockResolvedValueOnce({
        id: "s-1",
        parentTaskId: "parent-1",
      } as any);

      // checkBlockingSubtasks mock: not all complete
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            { id: "s-1", state: "completed", blocksParent: true },
            { id: "s-2", state: "running", blocksParent: true },
          ]),
        }),
      });

      await onSubtaskComplete("s-1");

      // Should not attempt to get parent or transition
      expect(taskService.transitionTask).not.toHaveBeenCalled();
    });

    it("does nothing when parent is not in pr_opened state", async () => {
      vi.mocked(taskService.getTask)
        .mockResolvedValueOnce({
          id: "s-1",
          parentTaskId: "parent-1",
        } as any)
        .mockResolvedValueOnce({
          id: "parent-1",
          state: "running",
          prUrl: "https://github.com/owner/repo/pull/1",
        } as any);

      // checkBlockingSubtasks: all complete
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "s-1", state: "completed", blocksParent: true }]),
        }),
      });

      await onSubtaskComplete("s-1");

      expect(taskService.transitionTask).not.toHaveBeenCalled();
    });

    it("attempts auto-merge only when the platform review is approved and autoMerge is enabled", async () => {
      vi.mocked(taskService.getTask)
        .mockResolvedValueOnce({
          id: "review-1",
          parentTaskId: "parent-1",
        } as any)
        .mockResolvedValueOnce({
          id: "parent-1",
          state: "pr_opened",
          prUrl: "https://github.com/owner/repo/pull/42",
          repoUrl: "https://github.com/owner/repo",
          workspaceId: null,
        } as any);

      mockCompletedReviewSubtaskQueries();
      mockDbUpdates();
      const mergePullRequest = mockObservedPr({
        reviews: [{ state: "APPROVED", body: "LGTM" }],
      });
      serviceMocks.getRepoByUrl.mockResolvedValue({ autoMerge: true, cautiousMode: false });

      await onSubtaskComplete("review-1");

      expect(mergePullRequest).toHaveBeenCalledWith(expect.any(Object), 42, "squash");

      expect(taskService.transitionTask).toHaveBeenCalledWith(
        "parent-1",
        "completed",
        "auto_merged",
        expect.stringContaining("PR #42"),
      );
    });

    it("logs warning when auto-merge fails", async () => {
      vi.mocked(taskService.getTask)
        .mockResolvedValueOnce({
          id: "review-1",
          parentTaskId: "parent-1",
        } as any)
        .mockResolvedValueOnce({
          id: "parent-1",
          state: "pr_opened",
          prUrl: "https://github.com/owner/repo/pull/10",
          repoUrl: "https://github.com/owner/repo",
          workspaceId: null,
        } as any);

      mockCompletedReviewSubtaskQueries();
      mockDbUpdates();
      serviceMocks.getRepoByUrl.mockResolvedValue({ autoMerge: true, cautiousMode: false });
      const mergePullRequest = mockObservedPr({
        prNumber: 10,
        reviews: [{ state: "APPROVED", body: "LGTM" }],
      });
      mergePullRequest.mockRejectedValueOnce(new Error("merge not allowed"));

      await onSubtaskComplete("review-1");

      expect(taskService.transitionTask).not.toHaveBeenCalled();
    });

    it("does not auto-merge when the review subtask completed without platform approval", async () => {
      vi.mocked(taskService.getTask)
        .mockResolvedValueOnce({
          id: "review-1",
          parentTaskId: "parent-1",
        } as any)
        .mockResolvedValueOnce({
          id: "parent-1",
          state: "pr_opened",
          prUrl: "https://github.com/owner/repo/pull/5",
          repoUrl: "https://github.com/owner/repo",
          workspaceId: null,
        } as any);

      mockCompletedReviewSubtaskQueries();
      mockDbUpdates();
      const mergePullRequest = mockObservedPr({
        prNumber: 5,
        reviews: [],
      });

      await onSubtaskComplete("review-1");

      expect(mergePullRequest).not.toHaveBeenCalled();
      expect(taskService.transitionTask).toHaveBeenCalledWith(
        "parent-1",
        "needs_attention",
        "review_missing_approval",
        "Review task completed but no approved platform review was observed",
      );
    });

    it("does not merge directly when platform review requests changes", async () => {
      vi.mocked(taskService.getTask)
        .mockResolvedValueOnce({
          id: "review-1",
          parentTaskId: "parent-1",
        } as any)
        .mockResolvedValueOnce({
          id: "parent-1",
          state: "pr_opened",
          prUrl: "https://github.com/owner/repo/pull/6",
          repoUrl: "https://github.com/owner/repo",
          workspaceId: null,
        } as any);

      mockCompletedReviewSubtaskQueries();
      mockDbUpdates();
      const mergePullRequest = mockObservedPr({
        prNumber: 6,
        reviews: [{ state: "CHANGES_REQUESTED", body: "Fix this" }],
      });

      await onSubtaskComplete("review-1");

      expect(mergePullRequest).not.toHaveBeenCalled();
      expect(serviceMocks.enqueueReconcile).toHaveBeenCalledWith(
        { kind: "repo", id: "parent-1" },
        { reason: "review_completed_changes_requested" },
      );
    });

    it("marks parent needs_attention when a review subtask fails", async () => {
      vi.mocked(taskService.getTask)
        .mockResolvedValueOnce({
          id: "review-1",
          parentTaskId: "parent-1",
          taskType: "review",
          state: "failed",
          errorMessage: "Agent exited with code 1",
        } as any)
        .mockResolvedValueOnce({
          id: "parent-1",
          state: "pr_opened",
          repoUrl: "https://github.com/owner/repo",
        } as any);

      await onSubtaskComplete("review-1");

      expect(taskService.transitionTask).toHaveBeenCalledWith(
        "parent-1",
        "needs_attention",
        "review_failed",
        "Review agent failed: Agent exited with code 1",
      );
      expect(serviceMocks.getGitPlatformForRepo).not.toHaveBeenCalled();
    });

    it("skips auto-merge when autoMerge is disabled on repo", async () => {
      vi.mocked(taskService.getTask)
        .mockResolvedValueOnce({
          id: "review-1",
          parentTaskId: "parent-1",
        } as any)
        .mockResolvedValueOnce({
          id: "parent-1",
          state: "pr_opened",
          prUrl: "https://github.com/owner/repo/pull/5",
          repoUrl: "https://github.com/owner/repo",
          workspaceId: null,
        } as any);

      mockCompletedReviewSubtaskQueries();
      mockDbUpdates();
      serviceMocks.getRepoByUrl.mockResolvedValue({ autoMerge: false, cautiousMode: false });
      const mergePullRequest = mockObservedPr({
        prNumber: 5,
        reviews: [{ state: "APPROVED", body: "LGTM" }],
      });

      await onSubtaskComplete("review-1");

      expect(mergePullRequest).not.toHaveBeenCalled();
      expect(taskService.transitionTask).not.toHaveBeenCalled();
      expect(serviceMocks.enqueueReconcile).toHaveBeenCalledWith(
        { kind: "repo", id: "parent-1" },
        { reason: "review_completed_auto_merge_not_ready" },
      );
    });

    it("auto-queues next step when a pipeline step completes", async () => {
      const stepSiblings = [
        { id: "step-1", taskType: "step", state: "completed", subtaskOrder: 0, blocksParent: true },
        { id: "step-2", taskType: "step", state: "pending", subtaskOrder: 1, blocksParent: true },
        { id: "step-3", taskType: "step", state: "pending", subtaskOrder: 2, blocksParent: true },
      ];

      // Step 1 completes, should auto-queue step 2
      vi.mocked(taskService.getTask)
        .mockResolvedValueOnce({
          id: "step-1",
          parentTaskId: "parent-1",
          taskType: "step",
          state: "completed",
          subtaskOrder: 0,
        } as any)
        // For queueSubtask (getTask for step-2)
        .mockResolvedValueOnce({
          id: "step-2",
          priority: 50,
          maxRetries: 3,
        } as any)
        // For parent lookup after checkBlockingSubtasks
        .mockResolvedValueOnce({
          id: "parent-1",
          state: "running",
          repoUrl: "https://github.com/owner/repo",
        } as any);

      // The mock needs to handle multiple db.select() calls:
      // 1. getSubtasks (has .orderBy) — returns step siblings
      // 2. checkBlockingSubtasks (no .orderBy) — returns blocking subtasks
      // 3. getSubtasks again for step completion check (has .orderBy) — returns step siblings
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            // Return an object that works both with and without .orderBy()
            const result = Promise.resolve(stepSiblings);
            (result as any).orderBy = vi.fn().mockResolvedValue(stepSiblings);
            return result;
          }),
        }),
      });

      await onSubtaskComplete("step-1");

      // Verify step-2 was queued (transitionTask called for it)
      expect(taskService.transitionTask).toHaveBeenCalledWith("step-2", "queued", "subtask_queued");
      expect(taskQueue.add).toHaveBeenCalledWith(
        "process-task",
        { taskId: "step-2" },
        expect.objectContaining({ jobId: "step-2" }),
      );
    });

    it("does not auto-queue next step when step fails", async () => {
      vi.mocked(taskService.getTask).mockResolvedValueOnce({
        id: "step-1",
        parentTaskId: "parent-1",
        taskType: "step",
        state: "failed", // Failed, not completed
        subtaskOrder: 0,
      } as any);

      // Mock db.select for checkBlockingSubtasks
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            const result = Promise.resolve([]);
            (result as any).orderBy = vi.fn().mockResolvedValue([]);
            return result;
          }),
        }),
      });

      await onSubtaskComplete("step-1");

      // queueSubtask should NOT have been called
      expect(taskService.transitionTask).not.toHaveBeenCalled();
    });
  });

  describe("getPipelineProgress", () => {
    it("returns null when no step subtasks exist", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await getPipelineProgress("parent-1");
      expect(result).toBeNull();
    });

    it("returns correct progress for a pipeline with steps", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([
              {
                id: "s-1",
                title: "Step 1",
                state: "completed",
                taskType: "step",
                subtaskOrder: 0,
              },
              {
                id: "s-2",
                title: "Step 2",
                state: "running",
                taskType: "step",
                subtaskOrder: 1,
              },
              {
                id: "s-3",
                title: "Step 3",
                state: "pending",
                taskType: "step",
                subtaskOrder: 2,
              },
            ]),
          }),
        }),
      });

      const result = await getPipelineProgress("parent-1");
      expect(result).not.toBeNull();
      expect(result!.totalSteps).toBe(3);
      expect(result!.completedSteps).toBe(1);
      expect(result!.runningSteps).toBe(1);
      expect(result!.failedSteps).toBe(0);
      expect(result!.currentStepIndex).toBe(2); // Step 2 is current
      expect(result!.currentStepTitle).toBe("Step 2");
      expect(result!.steps).toHaveLength(3);
    });

    it("ignores non-step subtasks in pipeline progress", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([
              {
                id: "s-1",
                title: "Step 1",
                state: "completed",
                taskType: "step",
                subtaskOrder: 0,
              },
              {
                id: "r-1",
                title: "Review",
                state: "running",
                taskType: "review",
                subtaskOrder: 1,
              },
              {
                id: "s-2",
                title: "Step 2",
                state: "pending",
                taskType: "step",
                subtaskOrder: 2,
              },
            ]),
          }),
        }),
      });

      const result = await getPipelineProgress("parent-1");
      expect(result).not.toBeNull();
      expect(result!.totalSteps).toBe(2); // Only step subtasks counted
      expect(result!.completedSteps).toBe(1);
    });

    it("reports all steps complete when pipeline is done", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([
              {
                id: "s-1",
                title: "Step 1",
                state: "completed",
                taskType: "step",
                subtaskOrder: 0,
              },
              {
                id: "s-2",
                title: "Step 2",
                state: "completed",
                taskType: "step",
                subtaskOrder: 1,
              },
            ]),
          }),
        }),
      });

      const result = await getPipelineProgress("parent-1");
      expect(result).not.toBeNull();
      expect(result!.totalSteps).toBe(2);
      expect(result!.completedSteps).toBe(2);
      expect(result!.currentStepIndex).toBe(2); // All complete, at the end
      expect(result!.currentStepTitle).toBeNull();
    });
  });
});
