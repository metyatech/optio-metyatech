/** Determine overall CI check status from platform check runs. */
export function determineCheckStatus(
  checkRuns: { status: string; conclusion: string | null }[],
): "none" | "pending" | "passing" | "failing" {
  if (checkRuns.length === 0) return "none";
  const allComplete = checkRuns.every((r) => r.status === "completed");
  const allSuccess = checkRuns.every(
    (r) => r.conclusion === "success" || r.conclusion === "skipped",
  );
  if (!allComplete) return "pending";
  if (allSuccess) return "passing";
  return "failing";
}

/** Determine review status from platform PR reviews. */
export function determineReviewStatus(reviews: { state: string; body?: string }[]): {
  status: "none" | "pending" | "approved" | "changes_requested";
  comments: string;
} {
  if (reviews.length === 0) return { status: "none", comments: "" };
  const substantive = reviews.filter((r) => r.state !== "COMMENTED" && r.state !== "DISMISSED");
  const latest = substantive[substantive.length - 1];
  if (latest) {
    if (latest.state === "APPROVED") return { status: "approved", comments: "" };
    if (latest.state === "CHANGES_REQUESTED") {
      return { status: "changes_requested", comments: latest.body || "" };
    }
  }
  if (reviews.some((r) => r.state === "COMMENTED")) return { status: "pending", comments: "" };
  return { status: "none", comments: "" };
}

export function shouldWakeTaskReconcilerForPrObservation(opts: {
  taskState: string;
  statusChanged: boolean;
  prState: "open" | "closed" | "merged";
  checksStatus: "none" | "pending" | "passing" | "failing" | "conflicts";
  reviewStatus: string;
}): boolean {
  if (opts.statusChanged) return true;

  return (
    opts.taskState === "needs_attention" &&
    opts.prState === "open" &&
    opts.checksStatus !== "failing" &&
    opts.checksStatus !== "conflicts" &&
    opts.reviewStatus !== "changes_requested"
  );
}
