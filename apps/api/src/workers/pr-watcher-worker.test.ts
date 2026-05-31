import { describe, it, expect } from "vitest";
import {
  determineCheckStatus,
  determineReviewStatus,
  shouldWakeTaskReconcilerForPrObservation,
} from "../services/pr-status-utils.js";

describe("determineCheckStatus", () => {
  it("returns none for empty check runs", () => {
    expect(determineCheckStatus([])).toBe("none");
  });

  it("returns pending when some checks are still running", () => {
    expect(
      determineCheckStatus([
        { status: "completed", conclusion: "success" },
        { status: "in_progress", conclusion: null },
      ]),
    ).toBe("pending");
  });

  it("returns passing when all checks succeed", () => {
    expect(
      determineCheckStatus([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "success" },
      ]),
    ).toBe("passing");
  });

  it("treats skipped as passing", () => {
    expect(
      determineCheckStatus([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "skipped" },
      ]),
    ).toBe("passing");
  });

  it("returns failing when any check fails", () => {
    expect(
      determineCheckStatus([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "failure" },
      ]),
    ).toBe("failing");
  });
});

describe("determineReviewStatus", () => {
  it("returns none for no reviews", () => {
    expect(determineReviewStatus([])).toEqual({ status: "none", comments: "" });
  });

  it("returns approved for APPROVED review", () => {
    expect(determineReviewStatus([{ state: "APPROVED", body: "LGTM" }])).toEqual({
      status: "approved",
      comments: "",
    });
  });

  it("returns changes_requested with body", () => {
    expect(determineReviewStatus([{ state: "CHANGES_REQUESTED", body: "Fix the tests" }])).toEqual({
      status: "changes_requested",
      comments: "Fix the tests",
    });
  });

  it("ignores COMMENTED and DISMISSED reviews for status", () => {
    expect(
      determineReviewStatus([{ state: "COMMENTED", body: "Nice work" }, { state: "DISMISSED" }]),
    ).toEqual({ status: "pending", comments: "" });
  });

  it("uses latest substantive review", () => {
    expect(
      determineReviewStatus([
        { state: "CHANGES_REQUESTED", body: "Fix X" },
        { state: "APPROVED", body: "Fixed" },
      ]),
    ).toEqual({ status: "approved", comments: "" });
  });
});

describe("shouldWakeTaskReconcilerForPrObservation", () => {
  it("wakes whenever observed PR status changed", () => {
    expect(
      shouldWakeTaskReconcilerForPrObservation({
        taskState: "pr_opened",
        statusChanged: true,
        prState: "open",
        checksStatus: "passing",
        reviewStatus: "none",
      }),
    ).toBe(true);
  });

  it("wakes unchanged needs_attention tasks when the PR no longer needs attention", () => {
    expect(
      shouldWakeTaskReconcilerForPrObservation({
        taskState: "needs_attention",
        statusChanged: false,
        prState: "open",
        checksStatus: "passing",
        reviewStatus: "none",
      }),
    ).toBe(true);
  });

  it("does not repeatedly wake unchanged needs_attention tasks that still need action", () => {
    expect(
      shouldWakeTaskReconcilerForPrObservation({
        taskState: "needs_attention",
        statusChanged: false,
        prState: "open",
        checksStatus: "failing",
        reviewStatus: "none",
      }),
    ).toBe(false);
    expect(
      shouldWakeTaskReconcilerForPrObservation({
        taskState: "needs_attention",
        statusChanged: false,
        prState: "open",
        checksStatus: "passing",
        reviewStatus: "changes_requested",
      }),
    ).toBe(false);
  });
});
