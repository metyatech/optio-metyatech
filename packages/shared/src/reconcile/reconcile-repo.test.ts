import { describe, it, expect } from "vitest";
import { reconcileRepo } from "./reconcile-repo.js";
import type {
  WorldSnapshot,
  RepoRunSpec,
  RepoRunStatus,
  Run,
  PrStatus,
  RepoStatus,
  DependencyObservation,
} from "./types.js";
import { TaskState } from "../types/task.js";

// ── Test fixtures ───────────────────────────────────────────────────────────

const NOW = new Date("2026-04-17T12:00:00Z");
const REVIEW_NO_CI_GRACE_MS = 60_000;

function makeSpec(overrides: Partial<RepoRunSpec> = {}): RepoRunSpec {
  return {
    repoUrl: "https://github.com/acme/repo",
    repoBranch: "main",
    agentType: "claude-code",
    prompt: "fix the bug",
    title: "Fix bug",
    taskType: "coding",
    maxRetries: 3,
    priority: 100,
    ignoreOffPeak: false,
    parentTaskId: null,
    blocksParent: false,
    workspaceId: "ws-1",
    workflowRunId: null,
    ...overrides,
  };
}

function makeStatus(overrides: Partial<RepoRunStatus> = {}): RepoRunStatus {
  return {
    state: TaskState.QUEUED,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecksStatus: null,
    prReviewStatus: null,
    prReviewComments: null,
    containerId: null,
    sessionId: null,
    worktreeState: null,
    lastPodId: null,
    lastActivityAt: null,
    retryCount: 0,
    errorMessage: null,
    costUsd: null,
    startedAt: null,
    completedAt: null,
    controlIntent: null,
    reconcileBackoffUntil: null,
    reconcileAttempts: 0,
    updatedAt: new Date(NOW.getTime() - 1000),
    ...overrides,
  };
}

function makePr(overrides: Partial<PrStatus> = {}): PrStatus {
  return {
    url: "https://github.com/acme/repo/pull/1",
    number: 1,
    state: "open",
    merged: false,
    mergeable: true,
    checksStatus: "none",
    reviewStatus: "none",
    latestReviewComments: null,
    ...overrides,
  };
}

function makeTaskRepo(overrides: Partial<RepoStatus> = {}): RepoStatus {
  return {
    id: "task-repo-1",
    repoUrl: "https://github.com/acme/repo",
    repoBranch: "main",
    prUrl: "https://github.com/acme/repo/pull/1",
    prNumber: 1,
    prState: "open",
    prChecksStatus: "none",
    prReviewStatus: "none",
    ciStatus: null,
    prOpenedAt: null,
    prChecksStatusChangedAt: null,
    mergeStatus: null,
    mergeOrder: null,
    mergeError: null,
    worktreeState: null,
    podId: null,
    ...overrides,
  };
}

type SnapshotExtras = Partial<Omit<WorldSnapshot, "settings">> & {
  settings?: Partial<WorldSnapshot["settings"]>;
};

function snapshot(
  spec: Partial<RepoRunSpec>,
  status: Partial<RepoRunStatus>,
  extras: SnapshotExtras = {},
): WorldSnapshot {
  const { settings: settingsOverrides, ...restExtras } = extras;
  const run: Run = {
    kind: "repo",
    ref: { kind: "repo", id: "task-1" },
    spec: makeSpec(spec),
    status: makeStatus(status),
  };
  return {
    now: NOW,
    run,
    pod: null,
    pr: null,
    dependencies: [],
    blockingSubtasks: [],
    capacity: {
      global: { running: 1, max: 5 },
      repo: { running: 0, max: 2 },
    },
    heartbeat: {
      lastActivityAt: null,
      isStale: false,
      silentForMs: 0,
    },
    settings: {
      stallThresholdMs: 300_000,
      autoMerge: false,
      cautiousMode: false,
      autoResume: false,
      reviewEnabled: false,
      reviewTrigger: null,
      reviewNoCiGraceMs: REVIEW_NO_CI_GRACE_MS,
      offPeakOnly: false,
      offPeakActive: false,
      hasReviewSubtask: false,
      maxAutoResumes: 10,
      recentAutoResumeCount: 0,
      ...settingsOverrides,
    },
    readErrors: [],
    ...restExtras,
  };
}

// ── Backoff & world-read failures ───────────────────────────────────────────

describe("reconcileRepo — backoff", () => {
  it("noops when reconcile_backoff_until is in the future", () => {
    const s = snapshot(
      {},
      {
        state: TaskState.RUNNING,
        reconcileBackoffUntil: new Date(NOW.getTime() + 60_000),
      },
    );
    expect(reconcileRepo(s).reason).toBe("reconcile_backoff_active");
  });
});

describe("reconcileRepo — world-read failures", () => {
  it("defers when pod read fails for a RUNNING task", () => {
    const s = snapshot(
      {},
      { state: TaskState.RUNNING },
      { readErrors: [{ source: "pod", message: "timeout" }] },
    );
    const action = reconcileRepo(s);
    expect(action.kind).toBe("deferWithBackoff");
  });

  it("does not defer on capacity read failure for a RUNNING task", () => {
    const s = snapshot(
      {},
      { state: TaskState.RUNNING },
      { readErrors: [{ source: "capacity", message: "timeout" }] },
    );
    const action = reconcileRepo(s);
    expect(action.kind).not.toBe("deferWithBackoff");
  });

  it("defers on capacity read failure for a QUEUED task", () => {
    const s = snapshot(
      {},
      { state: TaskState.QUEUED },
      { readErrors: [{ source: "capacity", message: "timeout" }] },
    );
    expect(reconcileRepo(s).kind).toBe("deferWithBackoff");
  });
});

// ── Control intent ──────────────────────────────────────────────────────────

describe("reconcileRepo — control intent", () => {
  it("cancel on QUEUED → CANCELLED", () => {
    const s = snapshot({}, { state: TaskState.QUEUED, controlIntent: "cancel" });
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") {
      expect(action.to).toBe(TaskState.CANCELLED);
      expect(action.clearControlIntent).toBe(true);
    }
  });

  it("cancel on RUNNING → CANCELLED", () => {
    const s = snapshot({}, { state: TaskState.RUNNING, controlIntent: "cancel" });
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") {
      expect(action.to).toBe(TaskState.CANCELLED);
    }
  });

  it("cancel on COMPLETED clears intent (terminal)", () => {
    const s = snapshot({}, { state: TaskState.COMPLETED, controlIntent: "cancel" });
    expect(reconcileRepo(s).kind).toBe("clearControlIntent");
  });

  it("cancel on FAILED clears intent (can't cancel failed)", () => {
    const s = snapshot({}, { state: TaskState.FAILED, controlIntent: "cancel" });
    expect(reconcileRepo(s).kind).toBe("clearControlIntent");
  });

  it("retry on FAILED with retries remaining → QUEUED", () => {
    const s = snapshot(
      { maxRetries: 3 },
      { state: TaskState.FAILED, controlIntent: "retry", retryCount: 1 },
    );
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") {
      expect(action.to).toBe(TaskState.QUEUED);
      expect(action.statusPatch?.retryCount).toBe(2);
    }
  });

  it("retry on CANCELLED → QUEUED", () => {
    const s = snapshot({}, { state: TaskState.CANCELLED, controlIntent: "retry" });
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") {
      expect(action.to).toBe(TaskState.QUEUED);
    }
  });

  it("retry exhausted clears intent", () => {
    const s = snapshot(
      { maxRetries: 3 },
      { state: TaskState.FAILED, controlIntent: "retry", retryCount: 3 },
    );
    expect(reconcileRepo(s).kind).toBe("clearControlIntent");
  });

  it("resume on NEEDS_ATTENTION → QUEUED", () => {
    const s = snapshot({}, { state: TaskState.NEEDS_ATTENTION, controlIntent: "resume" });
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") {
      expect(action.to).toBe(TaskState.QUEUED);
    }
  });

  it("resume on RUNNING clears intent (invalid state)", () => {
    const s = snapshot({}, { state: TaskState.RUNNING, controlIntent: "resume" });
    expect(reconcileRepo(s).kind).toBe("clearControlIntent");
  });

  it("restart on COMPLETED → QUEUED with reset", () => {
    const s = snapshot(
      {},
      {
        state: TaskState.COMPLETED,
        controlIntent: "restart",
        retryCount: 3,
        sessionId: "sess-1",
        containerId: "cont-1",
      },
    );
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") {
      expect(action.to).toBe(TaskState.QUEUED);
      expect(action.statusPatch?.retryCount).toBe(0);
      expect(action.statusPatch?.containerId).toBeNull();
    }
  });

  it("restart on FAILED → QUEUED", () => {
    const s = snapshot({}, { state: TaskState.FAILED, controlIntent: "restart" });
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") expect(action.to).toBe(TaskState.QUEUED);
  });
});

// ── PENDING ─────────────────────────────────────────────────────────────────

describe("reconcileRepo — PENDING", () => {
  it("with no deps → QUEUED", () => {
    const s = snapshot({}, { state: TaskState.PENDING });
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") expect(action.to).toBe(TaskState.QUEUED);
  });

  it("with deps → WAITING_ON_DEPS", () => {
    const deps: DependencyObservation[] = [
      { taskId: "dep-1", state: TaskState.RUNNING, blocksParent: false },
    ];
    const s = snapshot({}, { state: TaskState.PENDING }, { dependencies: deps });
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") expect(action.to).toBe(TaskState.WAITING_ON_DEPS);
  });
});

// ── WAITING_ON_DEPS ─────────────────────────────────────────────────────────

describe("reconcileRepo — WAITING_ON_DEPS", () => {
  it("all deps complete → QUEUED", () => {
    const deps: DependencyObservation[] = [
      { taskId: "dep-1", state: TaskState.COMPLETED, blocksParent: false },
      { taskId: "dep-2", state: TaskState.COMPLETED, blocksParent: false },
    ];
    const s = snapshot({}, { state: TaskState.WAITING_ON_DEPS }, { dependencies: deps });
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") expect(action.to).toBe(TaskState.QUEUED);
  });

  it("any dep failed → FAILED (cascade)", () => {
    const deps: DependencyObservation[] = [
      { taskId: "dep-1", state: TaskState.FAILED, blocksParent: false },
    ];
    const s = snapshot({}, { state: TaskState.WAITING_ON_DEPS }, { dependencies: deps });
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") {
      expect(action.to).toBe(TaskState.FAILED);
      expect(action.statusPatch?.errorMessage).toContain("dependency");
    }
  });

  it("deps still running → noop", () => {
    const deps: DependencyObservation[] = [
      { taskId: "dep-1", state: TaskState.RUNNING, blocksParent: false },
    ];
    const s = snapshot({}, { state: TaskState.WAITING_ON_DEPS }, { dependencies: deps });
    expect(reconcileRepo(s).kind).toBe("noop");
  });
});

// ── QUEUED ──────────────────────────────────────────────────────────────────

describe("reconcileRepo — QUEUED", () => {
  it("with capacity → requeueForAgent", () => {
    const s = snapshot({}, { state: TaskState.QUEUED });
    expect(reconcileRepo(s).kind).toBe("requeueForAgent");
  });

  it("global saturated → requeueSoon", () => {
    const s = snapshot(
      {},
      { state: TaskState.QUEUED },
      {
        capacity: {
          global: { running: 5, max: 5 },
          repo: { running: 0, max: 2 },
        },
      },
    );
    const action = reconcileRepo(s);
    expect(action.kind).toBe("requeueSoon");
  });

  it("repo saturated → requeueSoon", () => {
    const s = snapshot(
      {},
      { state: TaskState.QUEUED },
      {
        capacity: {
          global: { running: 1, max: 5 },
          repo: { running: 2, max: 2 },
        },
      },
    );
    expect(reconcileRepo(s).kind).toBe("requeueSoon");
  });

  it("off-peak blocked → requeueSoon", () => {
    const s = snapshot(
      { ignoreOffPeak: false },
      { state: TaskState.QUEUED },
      {
        settings: {
          stallThresholdMs: 300_000,
          autoMerge: false,
          cautiousMode: false,
          autoResume: false,
          reviewEnabled: false,
          reviewTrigger: null,
          offPeakOnly: true,
          offPeakActive: false,
          hasReviewSubtask: false,
          maxAutoResumes: 10,
          recentAutoResumeCount: 0,
        },
      },
    );
    const action = reconcileRepo(s);
    expect(action.kind).toBe("requeueSoon");
    expect(action.reason).toBe("off_peak_blocked");
  });

  it("off-peak with ignoreOffPeak → proceeds", () => {
    const s = snapshot(
      { ignoreOffPeak: true },
      { state: TaskState.QUEUED },
      {
        settings: {
          stallThresholdMs: 300_000,
          autoMerge: false,
          cautiousMode: false,
          autoResume: false,
          reviewEnabled: false,
          reviewTrigger: null,
          offPeakOnly: true,
          offPeakActive: false,
          hasReviewSubtask: false,
          maxAutoResumes: 10,
          recentAutoResumeCount: 0,
        },
      },
    );
    expect(reconcileRepo(s).kind).toBe("requeueForAgent");
  });
});

// ── PROVISIONING ────────────────────────────────────────────────────────────

describe("reconcileRepo — PROVISIONING", () => {
  it("pod error → FAILED", () => {
    const s = snapshot(
      {},
      { state: TaskState.PROVISIONING },
      {
        pod: {
          podName: "p1",
          phase: "error",
          lastError: "ImagePullBackOff",
        },
      },
    );
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") {
      expect(action.to).toBe(TaskState.FAILED);
      expect(action.statusPatch?.errorMessage).toBe("ImagePullBackOff");
    }
  });

  it("pod running → noop (worker advances)", () => {
    const s = snapshot(
      {},
      { state: TaskState.PROVISIONING },
      { pod: { podName: "p1", phase: "running", lastError: null } },
    );
    expect(reconcileRepo(s).kind).toBe("noop");
  });
});

// ── RUNNING ─────────────────────────────────────────────────────────────────

describe("reconcileRepo — RUNNING", () => {
  it("PR URL appears → transition to PR_OPENED", () => {
    const s = snapshot(
      {},
      {
        state: TaskState.RUNNING,
        prUrl: "https://github.com/acme/repo/pull/1",
      },
    );
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") expect(action.to).toBe(TaskState.PR_OPENED);
  });

  it("existing PR during CI-fix run stays RUNNING", () => {
    const s = snapshot(
      {},
      {
        state: TaskState.RUNNING,
        prUrl: "https://github.com/acme/repo/pull/1",
        prState: "open",
        prChecksStatus: "failing",
        prReviewStatus: "none",
      },
    );
    const action = reconcileRepo(s);
    expect(action.kind).toBe("noop");
    expect(action.reason).toBe("running_healthy");
  });

  it("stall detected → FAILED", () => {
    const s = snapshot(
      {},
      { state: TaskState.RUNNING },
      {
        heartbeat: {
          lastActivityAt: new Date(NOW.getTime() - 600_000),
          isStale: true,
          silentForMs: 600_000,
        },
      },
    );
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") {
      expect(action.to).toBe(TaskState.FAILED);
      expect(action.trigger).toBe("stall_detected");
    }
  });

  it("pod died → FAILED", () => {
    const s = snapshot(
      {},
      { state: TaskState.RUNNING },
      { pod: { podName: "p1", phase: "terminated", lastError: "OOMKilled" } },
    );
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") expect(action.to).toBe(TaskState.FAILED);
  });

  it("healthy → noop", () => {
    const s = snapshot(
      {},
      { state: TaskState.RUNNING },
      {
        pod: { podName: "p1", phase: "running", lastError: null },
        heartbeat: {
          lastActivityAt: new Date(NOW.getTime() - 5000),
          isStale: false,
          silentForMs: 5000,
        },
      },
    );
    expect(reconcileRepo(s).reason).toBe("running_healthy");
  });
});

// ── NEEDS_ATTENTION ─────────────────────────────────────────────────────────

describe("reconcileRepo — NEEDS_ATTENTION", () => {
  it("no intent → noop (awaits user)", () => {
    const s = snapshot({}, { state: TaskState.NEEDS_ATTENTION });
    expect(reconcileRepo(s).kind).toBe("noop");
  });

  it("moves back to PR_OPENED when CI attention has resolved externally", () => {
    const s = snapshot(
      {},
      {
        state: TaskState.NEEDS_ATTENTION,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
        prState: "open",
        prChecksStatus: "failing",
        errorMessage: "ci_failing_needs_attention",
      },
      {
        taskRepos: [makeTaskRepo({ prChecksStatus: "passing", ciStatus: "passing" })],
      },
    );

    const action = reconcileRepo(s);
    expect(action).toEqual({
      kind: "transition",
      to: TaskState.PR_OPENED,
      statusPatch: {
        prChecksStatus: "passing",
        prReviewStatus: "none",
        errorMessage: null,
      },
      trigger: "pr_attention_resolved",
      reason: "needs_attention_pr_status_resolved",
    });
  });

  it("preserves the passing CI edge when on_ci_pass review still needs to launch", () => {
    const s = snapshot(
      {},
      {
        state: TaskState.NEEDS_ATTENTION,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
        prState: "open",
        prChecksStatus: "failing",
        errorMessage: "ci_failing_needs_attention",
      },
      {
        taskRepos: [makeTaskRepo({ prChecksStatus: "passing", ciStatus: "passing" })],
        settings: {
          reviewEnabled: true,
          reviewTrigger: "on_ci_pass",
          hasReviewSubtask: false,
        },
      },
    );

    const action = reconcileRepo(s);
    expect(action).toEqual({
      kind: "transition",
      to: TaskState.PR_OPENED,
      statusPatch: {
        prReviewStatus: "none",
        errorMessage: null,
      },
      trigger: "pr_attention_resolved",
      reason: "needs_attention_pr_status_resolved",
    });
  });

  it("moves back to PR_OPENED when requested review changes are resolved externally", () => {
    const s = snapshot(
      {},
      {
        state: TaskState.NEEDS_ATTENTION,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
        prState: "open",
        prReviewStatus: "changes_requested",
        errorMessage: "review_changes_needs_attention",
      },
      {
        taskRepos: [makeTaskRepo({ prReviewStatus: "approved" })],
      },
    );

    const action = reconcileRepo(s);
    expect(action).toEqual({
      kind: "transition",
      to: TaskState.PR_OPENED,
      statusPatch: {
        prChecksStatus: "none",
        prReviewStatus: "approved",
        errorMessage: null,
      },
      trigger: "pr_attention_resolved",
      reason: "needs_attention_pr_status_resolved",
    });
  });

  it("moves back to PR_OPENED when no attention reason remains and PR is healthy", () => {
    const s = snapshot(
      {},
      {
        state: TaskState.NEEDS_ATTENTION,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
        prState: "open",
        prChecksStatus: "passing",
        prReviewStatus: "none",
        errorMessage: null,
      },
      {
        taskRepos: [makeTaskRepo({ prChecksStatus: "passing", ciStatus: "passing" })],
      },
    );

    const action = reconcileRepo(s);
    expect(action).toEqual({
      kind: "transition",
      to: TaskState.PR_OPENED,
      statusPatch: {
        errorMessage: null,
      },
      trigger: "pr_attention_resolved",
      reason: "needs_attention_pr_status_resolved",
    });
  });

  it("refreshes PR fields but keeps waiting when attention is still required", () => {
    const s = snapshot(
      {},
      {
        state: TaskState.NEEDS_ATTENTION,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
        prState: "open",
        prChecksStatus: "pending",
        errorMessage: "ci_failing_needs_attention",
      },
      {
        taskRepos: [makeTaskRepo({ prChecksStatus: "failing", ciStatus: "failing" })],
      },
    );

    const action = reconcileRepo(s);
    expect(action).toEqual({
      kind: "patchStatus",
      statusPatch: {
        prChecksStatus: "failing",
        prReviewStatus: "none",
      },
      reason: "needs_attention_pr_status_fields_refresh",
    });
  });
});

// ── PR_OPENED ───────────────────────────────────────────────────────────────

describe("reconcileRepo — PR_OPENED", () => {
  const openedStatus = (o: Partial<RepoRunStatus> = {}): Partial<RepoRunStatus> => ({
    state: TaskState.PR_OPENED,
    prUrl: "https://github.com/acme/repo/pull/1",
    prNumber: 1,
    ...o,
  });
  const onCiPassReviewSettings = (
    overrides: Partial<WorldSnapshot["settings"]> = {},
  ): Partial<WorldSnapshot["settings"]> => ({
    reviewEnabled: true,
    reviewTrigger: "on_ci_pass",
    ...overrides,
  });
  const noCiRepo = (ageMs: number, overrides: Partial<RepoStatus> = {}): RepoStatus => {
    const anchor = new Date(NOW.getTime() - ageMs);
    return makeTaskRepo({
      prChecksStatus: "none",
      ciStatus: "none",
      prOpenedAt: anchor,
      prChecksStatusChangedAt: anchor,
      ...overrides,
    });
  };

  it("PR merged → COMPLETED", () => {
    const s = snapshot({}, openedStatus(), { pr: makePr({ merged: true, state: "merged" }) });
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") expect(action.to).toBe(TaskState.COMPLETED);
  });

  it("PR closed without merge → FAILED", () => {
    const s = snapshot({}, openedStatus(), { pr: makePr({ state: "closed" }) });
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") expect(action.to).toBe(TaskState.FAILED);
  });

  it("merge conflicts, autoResume on → resumeAgent", () => {
    const s = snapshot({}, openedStatus({ prChecksStatus: "passing" }), {
      pr: makePr({ mergeable: false, checksStatus: "passing" }),
      settings: {
        stallThresholdMs: 300_000,
        autoMerge: false,
        cautiousMode: false,
        autoResume: true,
        reviewEnabled: false,
        reviewTrigger: null,
        offPeakOnly: false,
        offPeakActive: false,
        hasReviewSubtask: false,
        maxAutoResumes: 10,
        recentAutoResumeCount: 0,
      },
    });
    const action = reconcileRepo(s);
    expect(action.kind).toBe("resumeAgent");
    if (action.kind === "resumeAgent") expect(action.resumeReason).toBe("conflicts");
  });

  it("merge conflicts, autoResume off → NEEDS_ATTENTION", () => {
    const s = snapshot({}, openedStatus({ prChecksStatus: "passing" }), {
      pr: makePr({ mergeable: false, checksStatus: "passing" }),
    });
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") expect(action.to).toBe(TaskState.NEEDS_ATTENTION);
  });

  it("CI just started failing, autoResume → resumeAgent(ci_failure)", () => {
    const s = snapshot({}, openedStatus({ prChecksStatus: "passing" }), {
      pr: makePr({ checksStatus: "failing" }),
      settings: {
        stallThresholdMs: 300_000,
        autoMerge: false,
        cautiousMode: false,
        autoResume: true,
        reviewEnabled: false,
        reviewTrigger: null,
        offPeakOnly: false,
        offPeakActive: false,
        hasReviewSubtask: false,
        maxAutoResumes: 10,
        recentAutoResumeCount: 0,
      },
    });
    const action = reconcileRepo(s);
    expect(action.kind).toBe("resumeAgent");
    if (action.kind === "resumeAgent") expect(action.resumeReason).toBe("ci_failure");
  });

  it("CI failure from task_repos current status compares against persisted task status", () => {
    const s = snapshot({}, openedStatus({ prChecksStatus: "passing" }), {
      taskRepos: [makeTaskRepo({ prChecksStatus: "failing" })],
      settings: {
        stallThresholdMs: 300_000,
        autoMerge: false,
        cautiousMode: false,
        autoResume: true,
        reviewEnabled: false,
        reviewTrigger: null,
        offPeakOnly: false,
        offPeakActive: false,
        hasReviewSubtask: false,
        maxAutoResumes: 10,
        recentAutoResumeCount: 0,
      },
    });
    const action = reconcileRepo(s);
    expect(action.kind).toBe("resumeAgent");
    if (action.kind === "resumeAgent") expect(action.resumeReason).toBe("ci_failure");
  });

  it("CI just passed + on_ci_pass review → launchReview", () => {
    const s = snapshot({}, openedStatus({ prChecksStatus: "pending" }), {
      pr: makePr({ checksStatus: "passing" }),
      settings: {
        stallThresholdMs: 300_000,
        autoMerge: false,
        cautiousMode: false,
        autoResume: false,
        reviewEnabled: true,
        reviewTrigger: "on_ci_pass",
        offPeakOnly: false,
        offPeakActive: false,
        hasReviewSubtask: false,
        maxAutoResumes: 10,
        recentAutoResumeCount: 0,
      },
    });
    expect(reconcileRepo(s).kind).toBe("launchReview");
  });

  it("CI pass from task_repos current status compares against persisted task status", () => {
    const s = snapshot({}, openedStatus({ prChecksStatus: "pending" }), {
      taskRepos: [makeTaskRepo({ prChecksStatus: "passing" })],
      settings: {
        stallThresholdMs: 300_000,
        autoMerge: false,
        cautiousMode: false,
        autoResume: false,
        reviewEnabled: true,
        reviewTrigger: "on_ci_pass",
        offPeakOnly: false,
        offPeakActive: false,
        hasReviewSubtask: false,
        maxAutoResumes: 10,
        recentAutoResumeCount: 0,
      },
    });
    expect(reconcileRepo(s).kind).toBe("launchReview");
  });

  it("CI pass with existing review subtask does not launch duplicate review", () => {
    const s = snapshot({}, openedStatus({ prChecksStatus: "pending" }), {
      taskRepos: [makeTaskRepo({ prChecksStatus: "passing" })],
      settings: onCiPassReviewSettings({ hasReviewSubtask: true }),
    });
    expect(reconcileRepo(s).kind).not.toBe("launchReview");
  });

  it("no CI before grace requeues until on_ci_pass review grace expires", () => {
    const s = snapshot({}, openedStatus({ prChecksStatus: "none", prState: "open" }), {
      taskRepos: [noCiRepo(REVIEW_NO_CI_GRACE_MS - 1)],
      settings: onCiPassReviewSettings(),
    });
    const action = reconcileRepo(s);
    expect(action.kind).toBe("requeueSoon");
    if (action.kind === "requeueSoon") {
      expect(action.reason).toBe("ci_none_grace_pending");
      expect(action.delayMs).toBeGreaterThan(0);
      expect(action.delayMs).toBeLessThanOrEqual(REVIEW_NO_CI_GRACE_MS);
      expect(action.delayMs).toBe(1);
    }
  });

  it("no CI after grace launches on_ci_pass review", () => {
    const s = snapshot({}, openedStatus({ prChecksStatus: "none", prState: "open" }), {
      taskRepos: [noCiRepo(REVIEW_NO_CI_GRACE_MS)],
      settings: onCiPassReviewSettings(),
    });
    expect(reconcileRepo(s)).toEqual({
      kind: "launchReview",
      reason: "ci_none_grace_elapsed_launch_review",
    });
  });

  it("no CI after grace with existing review subtask does not launch duplicate review", () => {
    const s = snapshot({}, openedStatus({ prChecksStatus: "none", prState: "open" }), {
      taskRepos: [noCiRepo(REVIEW_NO_CI_GRACE_MS)],
      settings: onCiPassReviewSettings({ hasReviewSubtask: true }),
    });
    const action = reconcileRepo(s);
    expect(action.kind).not.toBe("launchReview");
    expect(action.kind).not.toBe("requeueSoon");
  });

  it("no CI grace uses the latest repo anchor across task repos", () => {
    const s = snapshot({}, openedStatus({ prChecksStatus: "none", prState: "open" }), {
      taskRepos: [
        noCiRepo(REVIEW_NO_CI_GRACE_MS + 1, { id: "task-repo-1" }),
        noCiRepo(REVIEW_NO_CI_GRACE_MS - 1, {
          id: "task-repo-2",
          prUrl: "https://github.com/acme/other/pull/2",
          prNumber: 2,
        }),
      ],
      settings: onCiPassReviewSettings(),
    });
    expect(reconcileRepo(s).kind).not.toBe("launchReview");
  });

  it("pending CI with on_ci_pass review remains pending and does not launch review", () => {
    const s = snapshot(
      {},
      openedStatus({ prChecksStatus: "pending", prReviewStatus: "none", prState: "open" }),
      {
        taskRepos: [makeTaskRepo({ prChecksStatus: "pending", ciStatus: "pending" })],
        settings: onCiPassReviewSettings(),
      },
    );
    expect(reconcileRepo(s).kind).toBe("noop");
  });

  it("failing CI with on_ci_pass review still needs attention instead of launching review", () => {
    const s = snapshot({}, openedStatus({ prChecksStatus: "pending", prState: "open" }), {
      taskRepos: [makeTaskRepo({ prChecksStatus: "failing", ciStatus: "failing" })],
      settings: onCiPassReviewSettings(),
    });
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") expect(action.to).toBe(TaskState.NEEDS_ATTENTION);
  });

  it("review changes from task_repos current status compares against persisted task status", () => {
    const s = snapshot({}, openedStatus({ prReviewStatus: "none" }), {
      taskRepos: [makeTaskRepo({ prReviewStatus: "changes_requested" })],
      settings: {
        stallThresholdMs: 300_000,
        autoMerge: false,
        cautiousMode: false,
        autoResume: true,
        reviewEnabled: true,
        reviewTrigger: "on_ci_pass",
        offPeakOnly: false,
        offPeakActive: false,
        hasReviewSubtask: false,
        maxAutoResumes: 10,
        recentAutoResumeCount: 0,
      },
    });
    const action = reconcileRepo(s);
    expect(action.kind).toBe("resumeAgent");
    if (action.kind === "resumeAgent") expect(action.resumeReason).toBe("review");
  });

  it("steady task_repos PR status does not re-trigger edge actions", () => {
    const s = snapshot(
      {},
      openedStatus({ prState: "open", prChecksStatus: "passing", prReviewStatus: "none" }),
      {
        taskRepos: [makeTaskRepo({ prChecksStatus: "passing" })],
        settings: {
          stallThresholdMs: 300_000,
          autoMerge: false,
          cautiousMode: false,
          autoResume: false,
          reviewEnabled: true,
          reviewTrigger: "on_ci_pass",
          offPeakOnly: false,
          offPeakActive: false,
          hasReviewSubtask: false,
          maxAutoResumes: 10,
          recentAutoResumeCount: 0,
        },
      },
    );
    expect(reconcileRepo(s).kind).toBe("noop");
  });

  it("first PR detection + on_pr review → launchReview", () => {
    const s = snapshot({}, openedStatus({ prChecksStatus: null }), {
      pr: makePr(),
      settings: {
        stallThresholdMs: 300_000,
        autoMerge: false,
        cautiousMode: false,
        autoResume: false,
        reviewEnabled: true,
        reviewTrigger: "on_pr",
        offPeakOnly: false,
        offPeakActive: false,
        hasReviewSubtask: false,
        maxAutoResumes: 10,
        recentAutoResumeCount: 0,
      },
    });
    expect(reconcileRepo(s).kind).toBe("launchReview");
  });

  it("auto-merge when CI passing and no subtasks blocking", () => {
    const s = snapshot({}, openedStatus({ prChecksStatus: "passing" }), {
      pr: makePr({ checksStatus: "passing" }),
      settings: {
        stallThresholdMs: 300_000,
        autoMerge: true,
        cautiousMode: false,
        autoResume: false,
        reviewEnabled: false,
        reviewTrigger: null,
        offPeakOnly: false,
        offPeakActive: false,
        hasReviewSubtask: false,
        maxAutoResumes: 10,
        recentAutoResumeCount: 0,
      },
    });
    expect(reconcileRepo(s).kind).toBe("autoMergePr");
  });

  it("does not auto-merge in cautiousMode", () => {
    const s = snapshot({}, openedStatus({ prChecksStatus: "passing" }), {
      pr: makePr({ checksStatus: "passing" }),
      settings: {
        stallThresholdMs: 300_000,
        autoMerge: true,
        cautiousMode: true,
        autoResume: false,
        reviewEnabled: false,
        reviewTrigger: null,
        offPeakOnly: false,
        offPeakActive: false,
        hasReviewSubtask: false,
        maxAutoResumes: 10,
        recentAutoResumeCount: 0,
      },
    });
    expect(reconcileRepo(s).kind).not.toBe("autoMergePr");
  });

  it("does not auto-merge when blocking subtasks incomplete", () => {
    const blockingSubs: DependencyObservation[] = [
      { taskId: "rev-1", state: TaskState.RUNNING, blocksParent: true },
    ];
    const s = snapshot({}, openedStatus({ prChecksStatus: "passing" }), {
      pr: makePr({ checksStatus: "passing" }),
      blockingSubtasks: blockingSubs,
      settings: {
        stallThresholdMs: 300_000,
        autoMerge: true,
        cautiousMode: false,
        autoResume: false,
        reviewEnabled: false,
        reviewTrigger: null,
        offPeakOnly: false,
        offPeakActive: false,
        hasReviewSubtask: false,
        maxAutoResumes: 10,
        recentAutoResumeCount: 0,
      },
    });
    expect(reconcileRepo(s).kind).not.toBe("autoMergePr");
  });

  it("review changes_requested, autoResume → resumeAgent(review)", () => {
    const s = snapshot({}, openedStatus({ prReviewStatus: "none" }), {
      pr: makePr({ reviewStatus: "changes_requested" }),
      settings: {
        stallThresholdMs: 300_000,
        autoMerge: false,
        cautiousMode: false,
        autoResume: true,
        reviewEnabled: false,
        reviewTrigger: null,
        offPeakOnly: false,
        offPeakActive: false,
        hasReviewSubtask: false,
        maxAutoResumes: 10,
        recentAutoResumeCount: 0,
      },
    });
    const action = reconcileRepo(s);
    expect(action.kind).toBe("resumeAgent");
    if (action.kind === "resumeAgent") expect(action.resumeReason).toBe("review");
  });

  it("pr_status_refresh emits patchStatus when fields drift", () => {
    const s = snapshot({}, openedStatus({ prChecksStatus: "pending", prState: "open" }), {
      pr: makePr({ checksStatus: "pending", state: "open", reviewStatus: "pending" }),
    });
    const action = reconcileRepo(s);
    expect(action.kind).toBe("patchStatus");
    if (action.kind === "patchStatus") {
      expect(action.statusPatch.prReviewStatus).toBe("pending");
    }
  });

  it("pr steady state → noop", () => {
    const s = snapshot(
      {},
      openedStatus({
        prChecksStatus: "pending",
        prReviewStatus: "pending",
        prState: "open",
      }),
      {
        pr: makePr({
          checksStatus: "pending",
          state: "open",
          reviewStatus: "pending",
        }),
      },
    );
    expect(reconcileRepo(s).kind).toBe("noop");
  });

  it("PR not yet available → noop (pr-watcher still populating)", () => {
    const s = snapshot({}, openedStatus({ prChecksStatus: null }), { pr: null });
    expect(reconcileRepo(s).reason).toBe("pr_info_not_yet_available");
  });
});

// ── FAILED ──────────────────────────────────────────────────────────────────

describe("reconcileRepo — FAILED", () => {
  it("no PR → noop (terminal without retry intent)", () => {
    const s = snapshot({}, { state: TaskState.FAILED });
    expect(reconcileRepo(s).kind).toBe("noop");
  });

  it("with PR that merged → COMPLETED", () => {
    const s = snapshot(
      {},
      {
        state: TaskState.FAILED,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
      },
      { pr: makePr({ merged: true, state: "merged" }) },
    );
    const action = reconcileRepo(s);
    expect(action.kind).toBe("transition");
    if (action.kind === "transition") expect(action.to).toBe(TaskState.COMPLETED);
  });

  it("with closed PR already failed → noop (no double-fail)", () => {
    const s = snapshot(
      {},
      {
        state: TaskState.FAILED,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
      },
      { pr: makePr({ state: "closed" }) },
    );
    expect(reconcileRepo(s).kind).toBe("noop");
  });
});

// ── Terminal states ─────────────────────────────────────────────────────────

describe("reconcileRepo — terminal states", () => {
  it("COMPLETED is a no-op", () => {
    const s = snapshot({}, { state: TaskState.COMPLETED });
    expect(reconcileRepo(s).kind).toBe("noop");
  });

  it("CANCELLED without intent is a no-op", () => {
    const s = snapshot({}, { state: TaskState.CANCELLED });
    expect(reconcileRepo(s).kind).toBe("noop");
  });
});

// ── Non-coding task types never drive PR-reactive actions ───────────────────

describe("reconcileRepo — non-coding task types", () => {
  const autoMergeReadySettings = {
    stallThresholdMs: 300_000,
    autoMerge: true,
    cautiousMode: false,
    autoResume: true,
    reviewEnabled: true,
    reviewTrigger: "on_ci_pass" as const,
    offPeakOnly: false,
    offPeakActive: false,
    hasReviewSubtask: false,
    maxAutoResumes: 10,
    recentAutoResumeCount: 0,
  };

  it("sanity: coding task with the same inputs DOES auto-merge", () => {
    // Paired positive test — if this breaks, the negative tests below are
    // passing for the wrong reason.
    const s = snapshot(
      { taskType: "coding" },
      {
        state: TaskState.PR_OPENED,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
        prChecksStatus: "passing",
      },
      {
        pr: makePr({ checksStatus: "passing", reviewStatus: "approved" }),
        settings: autoMergeReadySettings,
      },
    );
    expect(reconcileRepo(s).kind).toBe("autoMergePr");
  });

  it("pr_review with leaked prUrl + passing CI does NOT auto-merge (PR_OPENED)", () => {
    // Regression guard for the external-PR-review bug: an external-review task
    // whose prUrl points at someone else's PR must never trigger auto-merge,
    // even if all the surface gates (autoMerge, CI, no blocking subtasks) line up.
    const s = snapshot(
      { taskType: "pr_review" },
      {
        state: TaskState.PR_OPENED,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
        prChecksStatus: "passing",
      },
      {
        pr: makePr({ checksStatus: "passing" }),
        settings: autoMergeReadySettings,
      },
    );
    const action = reconcileRepo(s);
    expect(action.kind).not.toBe("autoMergePr");
    expect(action.kind).not.toBe("launchReview");
    expect(action.kind).not.toBe("resumeAgent");
  });

  it("pr_review with leaked prUrl does NOT launchReview on CI pass", () => {
    const s = snapshot(
      { taskType: "pr_review" },
      {
        state: TaskState.PR_OPENED,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
        prChecksStatus: null,
      },
      {
        pr: makePr({ checksStatus: "passing" }),
        settings: autoMergeReadySettings,
      },
    );
    expect(reconcileRepo(s).kind).not.toBe("launchReview");
  });

  it("pr_review RUNNING with leaked prUrl does NOT promote to PR_OPENED", () => {
    // decideRunning must not inherit the PR lifecycle for non-coding types.
    const s = snapshot(
      { taskType: "pr_review" },
      {
        state: TaskState.RUNNING,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
        lastActivityAt: NOW,
      },
    );
    const action = reconcileRepo(s);
    if (action.kind === "transition") {
      expect(action.to).not.toBe(TaskState.PR_OPENED);
    }
  });

  it("review subtask with leaked prUrl does NOT auto-merge", () => {
    // Same guard protects internal review subtasks too — defence in depth,
    // in case the snapshot loader ever regresses and populates PR state.
    const s = snapshot(
      { taskType: "review", parentTaskId: "parent-1", blocksParent: true },
      {
        state: TaskState.PR_OPENED,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
        prChecksStatus: "passing",
      },
      {
        pr: makePr({ checksStatus: "passing" }),
        settings: autoMergeReadySettings,
      },
    );
    expect(reconcileRepo(s).kind).not.toBe("autoMergePr");
  });

  it("pr_review FAILED with open PR does NOT auto-merge on recovery", () => {
    // FAILED with an open PR still passes through decideFromPrStatus — ensure
    // the non-coding guard covers that path too.
    const s = snapshot(
      { taskType: "pr_review" },
      {
        state: TaskState.FAILED,
        prUrl: "https://github.com/acme/repo/pull/1",
        prNumber: 1,
        prChecksStatus: "passing",
      },
      {
        pr: makePr({ checksStatus: "passing" }),
        settings: autoMergeReadySettings,
      },
    );
    expect(reconcileRepo(s).kind).not.toBe("autoMergePr");
  });
});
