export function getTaskComposerMode(opts: {
  isPlanReview: boolean;
  canResume: boolean;
  canMessage: boolean;
}): "plan_review" | "message" | "resume" {
  if (opts.isPlanReview) return "plan_review";
  if (opts.canMessage) return "message";
  return "resume";
}
