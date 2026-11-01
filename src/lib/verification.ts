/**
 * Unified task verification (G): strict rule used by BOTH mc_report_final
 * and writeAutoFinalReport. A job is Verified only when it is merged AND
 * backed by TASK-scoped passing product evidence (scoped review run on the
 * candidate). Jobs covered only by the repo-wide integration smoke stay out
 * of Verified — a shared integration run is one integration test, not
 * per-task verification. Manual fallback (no acceptance criteria) never
 * verifies. Anything else renders under Gaps, never under Verified.
 */
export interface TaskEvidenceView {
  testStatus?: string;
  scope?: string;
  testCommand?: string;
  reviewedCommit?: string;
  acceptanceLess?: boolean;
}

export function isTaskVerified(rec: TaskEvidenceView | null | undefined): boolean {
  if (!rec) return false;
  return (
    rec.testStatus === 'passed' &&
    rec.scope === 'task' &&
    Boolean(rec.reviewedCommit) &&
    !rec.acceptanceLess
  );
}
