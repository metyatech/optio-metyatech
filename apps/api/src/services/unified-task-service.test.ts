import { describe, expect, it, vi } from "vitest";
import type { ResolvedTask } from "./unified-task-service.js";

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock("../db/schema.js", () => ({
  tasks: {},
  taskConfigs: {},
  workflows: {},
  workflowRuns: {},
  workflowTriggers: {},
  prReviews: { workspaceId: "workspaceId", createdAt: "createdAt" },
  prReviewRuns: {},
}));

vi.mock("./task-service.js", () => ({
  getTask: vi.fn(),
  listTasks: vi.fn(),
}));

vi.mock("./task-config-service.js", () => ({
  getTaskConfig: vi.fn(),
  listTaskConfigs: vi.fn(),
}));

vi.mock("./workflow-service.js", () => ({
  getWorkflow: vi.fn(),
  listWorkflows: vi.fn(),
}));

vi.mock("./pr-review-service.js", () => ({
  getPrReview: vi.fn(),
}));

import { pageResolvedTasks, listUnifiedTasks } from "./unified-task-service.js";
import { db } from "../db/client.js";
import * as workflowService from "./workflow-service.js";
import * as prReviewService from "./pr-review-service.js";

function resolved(type: ResolvedTask["type"], id: string, createdAt: string): ResolvedTask {
  return { type, data: { id, createdAt } };
}

describe("pageResolvedTasks", () => {
  it("sorts by createdAt descending across task types", () => {
    const rows = [
      resolved("repo-task", "repo-old", "2026-01-01T00:00:00Z"),
      resolved("standalone", "standalone-new", "2026-01-03T00:00:00Z"),
      resolved("pr-review", "review-mid", "2026-01-02T00:00:00Z"),
    ];

    expect(pageResolvedTasks(rows, 0, 3).map((row) => row.data.id)).toEqual([
      "standalone-new",
      "review-mid",
      "repo-old",
    ]);
  });

  it("applies limit after sorting", () => {
    const rows = [
      resolved("repo-task", "repo-old", "2026-01-01T00:00:00Z"),
      resolved("standalone", "standalone-new", "2026-01-03T00:00:00Z"),
      resolved("repo-blueprint", "blueprint-mid", "2026-01-02T00:00:00Z"),
    ];

    expect(pageResolvedTasks(rows, 0, 2).map((row) => row.data.id)).toEqual([
      "standalone-new",
      "blueprint-mid",
    ]);
  });

  it("applies offset after sorting", () => {
    const rows = [
      resolved("repo-task", "repo-old", "2026-01-01T00:00:00Z"),
      resolved("standalone", "standalone-new", "2026-01-03T00:00:00Z"),
      resolved("repo-blueprint", "blueprint-mid", "2026-01-02T00:00:00Z"),
    ];

    expect(pageResolvedTasks(rows, 1, 2).map((row) => row.data.id)).toEqual([
      "blueprint-mid",
      "repo-old",
    ]);
  });

  it("uses id descending as a createdAt tie-breaker without mutating input", () => {
    const rows = [
      resolved("repo-task", "a", "2026-01-01T00:00:00Z"),
      resolved("standalone", "c", "2026-01-01T00:00:00Z"),
      resolved("pr-review", "b", "2026-01-01T00:00:00Z"),
    ];

    expect(pageResolvedTasks(rows, 0, 3).map((row) => row.data.id)).toEqual(["c", "b", "a"]);
    expect(rows.map((row) => row.data.id)).toEqual(["a", "c", "b"]);
  });
});

describe("listUnifiedTasks — pr-review ordering", () => {
  it("orders pr-review rows by createdAt desc to match pageResolvedTasks semantics", async () => {
    const prReviewRows = [
      { id: "review-1", workspaceId: null, createdAt: new Date("2026-04-01T00:00:00Z") },
      { id: "review-2", workspaceId: null, createdAt: new Date("2026-04-03T00:00:00Z") },
    ];
    const orderByMock = vi.fn().mockImplementation(() => ({
      limit: vi.fn().mockResolvedValue(prReviewRows),
    }));
    const whereMock = vi.fn().mockReturnValue({ orderBy: orderByMock });
    (db.select as any) = vi.fn().mockReturnValue({ from: () => ({ where: whereMock }) });
    vi.mocked(workflowService.listWorkflows).mockResolvedValue([] as any);
    vi.mocked(prReviewService.getPrReview).mockResolvedValue(null);

    await listUnifiedTasks({ type: "pr-review", workspaceId: null, limit: 50, offset: 0 });

    expect(orderByMock).toHaveBeenCalledTimes(1);
    // The single argument to orderBy should reference the prReviews.createdAt column.
    const arg = orderByMock.mock.calls[0][0];
    const sqlText = JSON.stringify(arg);
    expect(sqlText).toContain("createdAt");
    expect(sqlText).not.toContain("updatedAt");
  });
});
