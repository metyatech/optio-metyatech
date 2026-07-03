const PRE_RUN_MESSAGE_STATES = ["pending", "waiting_on_deps", "queued", "provisioning"];
const STOPPED_RESUME_STATES = ["needs_attention", "pr_opened", "failed", "cancelled"];

export interface TaskMessageComposerConfig {
  canMessage: boolean;
  canInterrupt: boolean;
  placeholder: string;
  sendLabel: string;
  helperText?: string;
}

export function getTaskComposerMode(opts: {
  isPlanReview: boolean;
  canResume: boolean;
  canMessage: boolean;
}): "plan_review" | "message" | "resume" {
  if (opts.isPlanReview && opts.canMessage) return "plan_review";
  if (opts.canMessage) return "message";
  return "resume";
}

export function getTaskMessageComposerConfig(opts: {
  state: string;
  agentType: string;
  prState?: string | null;
}): TaskMessageComposerConfig {
  const isStoppedResume = STOPPED_RESUME_STATES.includes(opts.state);
  const isPrClosed = opts.prState === "merged" || opts.prState === "closed";

  if (opts.state === "completed") {
    return {
      canMessage: false,
      canInterrupt: false,
      placeholder: "Task completed",
      sendLabel: "Resume",
      helperText: "Completed tasks cannot be resumed. Create a new task for follow-up work.",
    };
  }

  if (isStoppedResume && isPrClosed) {
    return {
      canMessage: false,
      canInterrupt: false,
      placeholder: "PR is closed",
      sendLabel: "Resume",
      helperText: "This PR is merged or closed. Create a new task for follow-up work.",
    };
  }

  if (PRE_RUN_MESSAGE_STATES.includes(opts.state)) {
    return {
      canMessage: true,
      canInterrupt: false,
      placeholder: "Add instructions before the agent starts...",
      sendLabel: "Add instruction",
    };
  }

  if (opts.state === "running" && opts.agentType === "claude-code") {
    return {
      canMessage: true,
      canInterrupt: true,
      placeholder: "Send a message to the running agent...",
      sendLabel: "Send",
    };
  }

  if (opts.state === "running") {
    return {
      canMessage: true,
      canInterrupt: false,
      placeholder: "Queue follow-up after the current run...",
      sendLabel: "Queue follow-up",
    };
  }

  if (isStoppedResume) {
    return {
      canMessage: true,
      canInterrupt: false,
      placeholder: "Send follow-up instructions to resume this task...",
      sendLabel: "Resume",
    };
  }

  return {
    canMessage: false,
    canInterrupt: false,
    placeholder: "Task cannot accept follow-up messages",
    sendLabel: "Resume",
    helperText: "This task cannot accept follow-up messages in its current state.",
  };
}
