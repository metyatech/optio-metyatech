import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkflowRunState } from "@optio/shared";

const workflowWorkerMocks = vi.hoisted(() => {
  const childLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    childLogger,
    mockQueueAdd: vi.fn().mockResolvedValue({}),
    capturedProcessor: undefined as
      | ((job: {
          id?: string;
          name: string;
          data: Record<string, unknown>;
          attemptsMade: number;
        }) => Promise<void>)
      | undefined,
  };
});

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock("../db/client.js", () => {
  const mockSelect = vi.fn().mockReturnThis();
  const mockFrom = vi.fn().mockReturnThis();
  const mockWhere = vi.fn().mockReturnThis();
  const mockUpdate = vi.fn().mockReturnThis();
  const mockSet = vi.fn().mockReturnThis();
  const mockReturning = vi.fn().mockResolvedValue([]);
  const mockInsert = vi.fn().mockReturnThis();
  const mockValues = vi.fn().mockReturnThis();

  return {
    db: {
      select: mockSelect,
      from: mockFrom,
      where: mockWhere,
      update: mockUpdate,
      set: mockSet,
      returning: mockReturning,
      insert: mockInsert,
      values: mockValues,
    },
  };
});

vi.mock("../db/schema.js", () => ({
  workflowRuns: { id: "id", workflowId: "workflow_id", state: "state" },
  workflows: { id: "id" },
  workflowPods: { id: "id" },
}));

vi.mock("../services/redis-config.js", () => ({
  getBullMQConnectionOptions: () => ({ url: "redis://localhost:6379", maxRetriesPerRequest: null }),
}));

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: workflowWorkerMocks.mockQueueAdd,
    close: vi.fn().mockResolvedValue(undefined),
  })),
  Worker: vi.fn().mockImplementation((_name: string, fn: unknown, _opts: unknown) => {
    workflowWorkerMocks.capturedProcessor = fn as typeof workflowWorkerMocks.capturedProcessor;
    return {
      on: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

vi.mock("../services/workflow-service.js", () => ({
  getWorkflow: vi.fn(),
  getWorkflowRun: vi.fn(),
  appendWorkflowRunLog: vi.fn().mockResolvedValue({}),
}));

vi.mock("../services/workflow-pool-service.js", () => ({
  getOrCreateWorkflowPod: vi.fn(),
  execRunInPod: vi.fn(),
  releaseRun: vi.fn(),
}));

vi.mock("../services/agent-event-parser.js", () => ({
  parseClaudeEvent: vi.fn().mockReturnValue({ entries: [], sessionId: undefined }),
}));

vi.mock("../services/event-bus.js", () => ({
  publishWorkflowRunEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/secret-service.js", () => ({
  resolveSecretsForTask: vi.fn().mockResolvedValue({}),
  retrieveSecretWithFallback: vi.fn().mockResolvedValue(null),
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue(workflowWorkerMocks.childLogger),
  },
}));

// Import after mocks
import { db } from "../db/client.js";
import { publishWorkflowRunEvent } from "../services/event-bus.js";
import * as workflowService from "../services/workflow-service.js";
import {
  buildWorkflowAgentCommand,
  renderWorkflowPrompt,
  startWorkflowWorker,
} from "./workflow-worker.js";

describe("renderWorkflowPrompt", () => {
  it("replaces param variables in the template", () => {
    const template = "Analyze {{repo}} and fix {{issue}}";
    const params = { repo: "my-app", issue: "bug #42" };
    const result = renderWorkflowPrompt(template, params);
    expect(result).toBe("Analyze my-app and fix bug #42");
  });

  it("leaves unknown variables as-is", () => {
    const template = "Process {{known}} and {{unknown}}";
    const params = { known: "value" };
    const result = renderWorkflowPrompt(template, params);
    expect(result).toBe("Process value and {{unknown}}");
  });

  it("handles empty params", () => {
    const template = "No params here";
    const result = renderWorkflowPrompt(template, {});
    expect(result).toBe("No params here");
  });

  it("handles null/undefined params", () => {
    const template = "No params here";
    const result = renderWorkflowPrompt(template, undefined);
    expect(result).toBe("No params here");
  });

  it("converts non-string param values to strings", () => {
    const template = "Count: {{count}}, active: {{active}}";
    const params = { count: 42, active: true };
    const result = renderWorkflowPrompt(template, params);
    expect(result).toBe("Count: 42, active: true");
  });
});

describe("buildWorkflowAgentCommand", () => {
  describe("claude-code agent", () => {
    it("produces a claude command with stream-json output", () => {
      const cmds = buildWorkflowAgentCommand("claude-code", {
        OPTIO_PROMPT: "Run analysis",
      });

      expect(cmds.some((c) => c.includes("claude --print"))).toBe(true);
      expect(cmds.some((c) => c.includes("--dangerously-skip-permissions"))).toBe(true);
      expect(cmds.some((c) => c.includes("--output-format stream-json"))).toBe(true);
      expect(cmds.some((c) => c.includes("--verbose"))).toBe(true);
    });

    it("uses workflow maxTurns when specified", () => {
      const cmds = buildWorkflowAgentCommand(
        "claude-code",
        {
          OPTIO_PROMPT: "Do work",
        },
        { maxTurns: 50 },
      );
      expect(cmds.some((c) => c.includes("--max-turns 50"))).toBe(true);
    });

    it("defaults to 250 max turns when not specified", () => {
      const cmds = buildWorkflowAgentCommand("claude-code", {
        OPTIO_PROMPT: "Do work",
      });
      expect(cmds.some((c) => c.includes("--max-turns 250"))).toBe(true);
    });

    it("adds --model flag when OPTIO_CLAUDE_MODEL is set", () => {
      const cmds = buildWorkflowAgentCommand("claude-code", {
        OPTIO_PROMPT: "Do work",
        OPTIO_CLAUDE_MODEL: "sonnet",
      });
      expect(cmds.some((c) => c.includes("--model sonnet"))).toBe(true);
    });

    it("does not embed the prompt in the command", () => {
      const cmds = buildWorkflowAgentCommand("claude-code", {
        OPTIO_PROMPT: "SECRET PROMPT TEXT",
      });
      const joined = cmds.join("\n");
      expect(joined).not.toContain("SECRET PROMPT TEXT");
    });
  });

  describe("codex agent", () => {
    it("produces a codex exec command", () => {
      const cmds = buildWorkflowAgentCommand("codex", {
        OPTIO_PROMPT: "Build feature",
      });
      expect(cmds.some((c) => c.includes("codex exec"))).toBe(true);
      expect(cmds.some((c) => c.includes("--full-auto"))).toBe(true);
    });
  });

  describe("unknown agent", () => {
    it("produces an error for unknown agent types", () => {
      const cmds = buildWorkflowAgentCommand("unknown-agent", {
        OPTIO_PROMPT: "Do something",
      });
      expect(cmds.some((c) => c.includes("Unknown agent type"))).toBe(true);
      expect(cmds.some((c) => c.includes("exit 1"))).toBe(true);
    });
  });
});

describe("startWorkflowWorker state claiming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workflowWorkerMocks.capturedProcessor = undefined;
  });

  it("does not publish or delayed requeue when claim CAS loses and the fresh run is running", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const queuedRun = {
      id: "wr-1",
      workflowId: "wf-1",
      triggerId: null,
      params: null,
      state: WorkflowRunState.QUEUED,
      output: null,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      modelUsed: null,
      errorMessage: null,
      sessionId: null,
      podName: null,
      podId: null,
      lastPodId: null,
      retryCount: 0,
      startedAt: null,
      finishedAt: null,
      controlIntent: null,
      reconcileBackoffUntil: null,
      reconcileAttempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    vi.mocked(workflowService.getWorkflowRun)
      .mockResolvedValueOnce(queuedRun)
      .mockResolvedValueOnce({ ...queuedRun, state: WorkflowRunState.RUNNING });
    vi.mocked(workflowService.getWorkflow).mockResolvedValue({
      id: "wf-1",
      name: "Test workflow",
      description: null,
      workspaceId: null,
      promptTemplate: "Do work",
      paramsSchema: null,
      agentRuntime: "claude-code",
      model: null,
      maxTurns: null,
      budgetUsd: null,
      maxConcurrent: 5,
      maxRetries: 1,
      warmPoolSize: 0,
      maxPodInstances: 1,
      maxAgentsPerPod: 2,
      enabled: true,
      environmentSpec: null,
      createdBy: null,
      createdAt: now,
      updatedAt: now,
    });

    const mockDb = db as typeof db & {
      where: ReturnType<typeof vi.fn>;
      returning: ReturnType<typeof vi.fn>;
    };
    mockDb.where.mockResolvedValueOnce([]);
    mockDb.returning.mockResolvedValueOnce([]);

    startWorkflowWorker();
    expect(workflowWorkerMocks.capturedProcessor).toBeDefined();
    await workflowWorkerMocks.capturedProcessor?.({
      id: "job-1",
      name: "process-workflow-run",
      data: { workflowRunId: "wr-1" },
      attemptsMade: 0,
    });

    expect(publishWorkflowRunEvent).not.toHaveBeenCalled();
    expect(workflowWorkerMocks.mockQueueAdd).not.toHaveBeenCalled();
    expect(workflowService.getWorkflowRun).toHaveBeenCalledTimes(2);
    expect(workflowWorkerMocks.childLogger.info).toHaveBeenCalledWith(
      { state: WorkflowRunState.RUNNING },
      "Skipping delayed workflow requeue because run is no longer queued",
    );
  });
});
