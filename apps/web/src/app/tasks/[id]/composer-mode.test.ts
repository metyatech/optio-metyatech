import { describe, expect, it } from "vitest";
import { getTaskMessageComposerConfig, getTaskComposerMode } from "./composer-mode";

describe("getTaskComposerMode", () => {
  it("returns plan_review when isPlanReview and canMessage", () => {
    expect(getTaskComposerMode({ isPlanReview: true, canResume: false, canMessage: true })).toBe(
      "plan_review",
    );
  });

  it("returns message when canMessage and not plan review", () => {
    expect(getTaskComposerMode({ isPlanReview: false, canResume: false, canMessage: true })).toBe(
      "message",
    );
  });

  it("returns resume when canMessage is false", () => {
    expect(getTaskComposerMode({ isPlanReview: false, canResume: true, canMessage: false })).toBe(
      "resume",
    );
  });
});

describe("getTaskMessageComposerConfig", () => {
  it.each(["pending", "waiting_on_deps", "queued", "provisioning"])(
    "allows pre-run messages in %s with add-instruction copy",
    (state) => {
      expect(
        getTaskMessageComposerConfig({ state, agentType: "codex", prState: null }),
      ).toMatchObject({
        canMessage: true,
        canInterrupt: false,
        placeholder: "Add instructions before the agent starts...",
        sendLabel: "Add instruction",
      });
    },
  );

  it("allows running Claude Code messages with interrupt", () => {
    expect(
      getTaskMessageComposerConfig({ state: "running", agentType: "claude-code" }),
    ).toMatchObject({
      canMessage: true,
      canInterrupt: true,
      placeholder: "Send a message to the running agent...",
      sendLabel: "Send",
    });
  });

  it("queues running non-Claude follow-ups without interrupt", () => {
    expect(getTaskMessageComposerConfig({ state: "running", agentType: "codex" })).toMatchObject({
      canMessage: true,
      canInterrupt: false,
      placeholder: "Queue follow-up after the current run...",
      sendLabel: "Queue follow-up",
    });
  });

  it.each(["needs_attention", "pr_opened", "failed", "cancelled"])(
    "allows stopped resume messages in %s",
    (state) => {
      expect(
        getTaskMessageComposerConfig({ state, agentType: "opencode", prState: "open" }),
      ).toMatchObject({
        canMessage: true,
        canInterrupt: false,
        placeholder: "Send follow-up instructions to resume this task...",
        sendLabel: "Resume",
      });
    },
  );

  it("blocks completed tasks with the canonical helper text", () => {
    expect(
      getTaskMessageComposerConfig({ state: "completed", agentType: "claude-code" }),
    ).toMatchObject({
      canMessage: false,
      canInterrupt: false,
      helperText: "Completed tasks cannot be resumed. Create a new task for follow-up work.",
    });
  });

  it.each(["merged", "closed"])("blocks stopped tasks when the PR is %s", (prState) => {
    expect(
      getTaskMessageComposerConfig({ state: "pr_opened", agentType: "claude-code", prState }),
    ).toMatchObject({
      canMessage: false,
      canInterrupt: false,
      helperText: "This PR is merged or closed. Create a new task for follow-up work.",
    });
  });
});
