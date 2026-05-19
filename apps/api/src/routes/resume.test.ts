import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { mockTask } from "../test-utils/fixtures.js";

// ─── Mocks ───

const mockGetTask = vi.fn();
const mockGetTaskEvents = vi.fn();
const mockTransitionTask = vi.fn();

vi.mock("../services/task-service.js", () => ({
  getTask: (...args: unknown[]) => mockGetTask(...args),
  getTaskEvents: (...args: unknown[]) => mockGetTaskEvents(...args),
  transitionTask: (...args: unknown[]) => mockTransitionTask(...args),
}));

const mockQueueAdd = vi.fn().mockResolvedValue(undefined);

vi.mock("../workers/task-worker.js", () => ({
  taskQueue: {
    add: (...args: unknown[]) => mockQueueAdd(...args),
  },
}));

import { resumeRoutes } from "./resume.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(resumeRoutes);
}

const mockTaskData = {
  ...mockTask,
  state: "failed",
  sessionId: "sess-1",
};

describe("POST /api/tasks/:id/resume", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetTaskEvents.mockResolvedValue([]);
    app = await buildTestApp();
  });

  it("resumes a failed task", async () => {
    mockGetTask
      .mockResolvedValueOnce(mockTaskData)
      .mockResolvedValueOnce({ ...mockTaskData, state: "queued" });
    mockTransitionTask.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/resume",
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(mockTransitionTask).toHaveBeenCalledWith("task-1", "queued", "user_resume", undefined);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-task",
      expect.objectContaining({
        taskId: "task-1",
        resumeSessionId: "sess-1",
        resumePrompt: "Continue working on this task.",
      }),
      expect.any(Object),
    );
  });

  it("resumes with custom prompt", async () => {
    mockGetTask
      .mockResolvedValueOnce({ ...mockTaskData, state: "needs_attention" })
      .mockResolvedValueOnce({ ...mockTaskData, state: "queued" });
    mockTransitionTask.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/resume",
      payload: { prompt: "Fix the tests" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockTransitionTask).toHaveBeenCalledWith(
      "task-1",
      "queued",
      "user_resume",
      "Fix the tests",
    );
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-task",
      expect.objectContaining({ resumePrompt: "Fix the tests" }),
      expect.any(Object),
    );
  });

  it("keeps planning mode on plan-review feedback (fresh session)", async () => {
    mockGetTask
      .mockResolvedValueOnce({
        ...mockTaskData,
        state: "needs_attention",
        resultSummary: "Plan v1",
      })
      .mockResolvedValueOnce({ ...mockTaskData, state: "queued" });
    mockGetTaskEvents.mockResolvedValue([{ trigger: "plan_review" }]);
    mockTransitionTask.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/resume",
      payload: { prompt: "Please refine risk section" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-task",
      expect.objectContaining({
        taskId: "task-1",
        resumeSessionId: undefined,
        resumePrompt: expect.stringContaining("You are still in PLANNING MODE"),
        approvedPlanPath: undefined,
      }),
      expect.any(Object),
    );
    const payload = mockQueueAdd.mock.calls.at(-1)?.[1] as { resumePrompt: string };
    expect(payload.resumePrompt).toContain("Current plan content is delimited below");
    expect(payload.resumePrompt).toContain("<current_plan>");
    expect(payload.resumePrompt).toContain("<reviewer_feedback>");
    expect(payload.resumePrompt).toContain("Plan v1");
    expect(payload.resumePrompt).toContain("Please refine risk section");
  });

  it("approving plan switches to implementation prompt with approved plan injected", async () => {
    mockGetTask
      .mockResolvedValueOnce({
        ...mockTaskData,
        state: "needs_attention",
        resultSummary: "# Approved Plan\n- Step 1\n- Step 2",
      })
      .mockResolvedValueOnce({ ...mockTaskData, state: "queued" });
    mockGetTaskEvents.mockResolvedValue([{ trigger: "plan_review" }]);
    mockTransitionTask.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/resume",
      payload: { prompt: "Plan approved. Proceed with implementation." },
    });

    expect(res.statusCode).toBe(200);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-task",
      expect.objectContaining({
        taskId: "task-1",
        resumeSessionId: "sess-1",
        approvedPlanPath: ".optio/plan.md",
        approvedPlanContent: "# Approved Plan\n- Step 1\n- Step 2",
        resumePrompt: expect.stringContaining("Follow the approved plan from .optio/plan.md"),
      }),
      expect.any(Object),
    );
    const queuedPayload = mockQueueAdd.mock.calls.at(-1)?.[1] as { resumePrompt: string };
    expect(queuedPayload.resumePrompt).toContain('<approved_plan path=".optio/plan.md">');
    expect(queuedPayload.resumePrompt).toContain("# Approved Plan");
  });

  it("returns 404 for nonexistent task", async () => {
    mockGetTask.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/nonexistent/resume",
      payload: {},
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 409 for task not in resumable state", async () => {
    mockGetTask.mockResolvedValue({ ...mockTaskData, state: "running" });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/resume",
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("Cannot resume task in running state");
  });

  it("returns 404 for task in different workspace", async () => {
    mockGetTask.mockResolvedValue({ ...mockTaskData, workspaceId: "ws-other" });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/resume",
      payload: {},
    });

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/tasks/:id/force-restart", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("force-restarts a failed task", async () => {
    mockGetTask
      .mockResolvedValueOnce(mockTaskData)
      .mockResolvedValueOnce({ ...mockTaskData, state: "queued" });
    mockTransitionTask.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/force-restart",
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(mockTransitionTask).toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-task",
      expect.objectContaining({ taskId: "task-1" }),
      expect.any(Object),
    );
    // No resumeSessionId should be present (fresh session)
    const addCall = mockQueueAdd.mock.calls[0][1];
    expect(addCall.resumeSessionId).toBeUndefined();
  });

  it("builds context-aware prompt for PR with failing CI", async () => {
    const taskWithPr = {
      ...mockTaskData,
      state: "pr_opened",
      prUrl: "https://github.com/org/repo/pull/1",
      prChecksStatus: "failing",
    };
    mockGetTask
      .mockResolvedValueOnce(taskWithPr)
      .mockResolvedValueOnce({ ...taskWithPr, state: "queued" });
    mockTransitionTask.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/force-restart",
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const addCall = mockQueueAdd.mock.calls[0][1];
    expect(addCall.resumePrompt).toContain("existing PR");
    expect(addCall.resumePrompt).toContain("CI checks are failing");
    expect(addCall.restartFromBranch).toBe(true);
  });

  it("builds prompt for changes requested", async () => {
    const taskWithReview = {
      ...mockTaskData,
      state: "needs_attention",
      prUrl: "https://github.com/org/repo/pull/1",
      prReviewStatus: "changes_requested",
      prReviewComments: "Please add tests",
    };
    mockGetTask
      .mockResolvedValueOnce(taskWithReview)
      .mockResolvedValueOnce({ ...taskWithReview, state: "queued" });
    mockTransitionTask.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/force-restart",
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const addCall = mockQueueAdd.mock.calls[0][1];
    expect(addCall.resumePrompt).toContain("Please add tests");
  });

  it("returns 409 for task not in restartable state", async () => {
    mockGetTask.mockResolvedValue({ ...mockTaskData, state: "running" });

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/force-restart",
      payload: {},
    });

    expect(res.statusCode).toBe(409);
  });

  it("uses custom prompt if provided", async () => {
    mockGetTask
      .mockResolvedValueOnce(mockTaskData)
      .mockResolvedValueOnce({ ...mockTaskData, state: "queued" });
    mockTransitionTask.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/task-1/force-restart",
      payload: { prompt: "Just fix the linting issues" },
    });

    expect(res.statusCode).toBe(200);
    const addCall = mockQueueAdd.mock.calls[0][1];
    expect(addCall.resumePrompt).toBe("Just fix the linting issues");
  });
});
