/** Compact summary of a lifecycle probe result, without the noise. */
import fs from "node:fs";

const file = process.argv[2];
const j = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));

const compact = (phase) => ({
  executorThreadId: phase.executorThreadId,
  historyMode: phase.historyMode,
  error: phase.error ?? null,
  reviewThreadId: phase.reviewThreadId ?? null,
  separateReviewThreadId: phase.separateReviewThreadId ?? null,
  reviewTurnId: phase.reviewTurnId ?? null,
  reviewThreadIsIndependent: phase.reviewThreadIsIndependent ?? null,
  independentFromExecutor: phase.independentFromExecutor ?? null,
  turnStatus: phase.turnStatus ?? null,
  reviewItemTypes: (phase.reviewItems ?? []).map((r) => `${r.method}:${r.itemType}`),
  reviewTextLengths: (phase.reviewItems ?? [])
    .filter((r) => typeof r.reviewText === "string")
    .map((r) => r.reviewText.length),
  reviewTextLooksLikeJson: (phase.reviewItems ?? [])
    .filter((r) => typeof r.reviewText === "string")
    .map((r) => /^\s*\{/.test(r.reviewText)),
  reviewTextHead: (phase.reviewItems ?? [])
    .filter((r) => typeof r.reviewText === "string")
    .map((r) => r.reviewText.slice(0, 160)),
  renderedFindingsMarker: phase.renderedFindingsMarker ?? null,
  notificationCount: (phase.timeline ?? []).length,
});

console.log(JSON.stringify({
  initialize: j.initialize,
  detachedReview: j.phases?.detachedReview ? compact(j.phases.detachedReview) : j.phases?.detachedReview,
  inlineReviewOnSeparateThread: j.phases?.inlineReviewOnSeparateThread
    ? compact(j.phases.inlineReviewOnSeparateThread)
    : j.phases?.inlineReviewOnSeparateThread,
  deprecationNotices: (j.deprecationNotices ?? []).map((d) => d.summary),
  error: j.error ?? null,
}, null, 2));
