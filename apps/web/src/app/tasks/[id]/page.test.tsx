import { describe, expect, it } from "vitest";
import { getTaskComposerMode } from "./composer-mode";

describe("getTaskComposerMode", () => {
  it("prioritizes plan review controls over generic chat composer", () => {
    expect(
      getTaskComposerMode({
        isPlanReview: true,
        canResume: true,
        canMessage: true,
      }),
    ).toBe("plan_review");
  });

  it("shows plan review controls even when canResume is false", () => {
    expect(
      getTaskComposerMode({
        isPlanReview: true,
        canResume: false,
        canMessage: true,
      }),
    ).toBe("plan_review");
  });

  it("uses message composer when not in plan review", () => {
    expect(
      getTaskComposerMode({
        isPlanReview: false,
        canResume: true,
        canMessage: true,
      }),
    ).toBe("message");
  });

  it("falls back to resume bar when messaging is unavailable", () => {
    expect(
      getTaskComposerMode({
        isPlanReview: false,
        canResume: false,
        canMessage: false,
      }),
    ).toBe("resume");
  });
});
