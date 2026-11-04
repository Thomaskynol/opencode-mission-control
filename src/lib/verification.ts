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

/**
 * Trivial no-op test command: `true` é comando-ok, NÃO teste funcional.
 * Casa apenas o no-op puro ancorado (nunca substring de comando real):
 * `true`, `:`, `exit 0`, `/bin/true`, `/usr/bin/true`, `echo` puro.
 * Composto com encadeamento (&&, ||, ;, |, $(), ``) nunca é trivial —
 * pode conter teste real e não deve ser barrado por substring.
 */
export function isTrivialTestCommand(cmd?: string | null): boolean {
  if (!cmd) return false;
  const t = cmd.trim();
  if (!t) return false;
  // Composto/controle: pode embutir teste real — nunca classificar por substring.
  if (/[\n]/.test(t)) return false;
  if (/&&|\|\||[|;&]/.test(t)) return false;
  if (/\$\(|`|\(|\)/.test(t)) return false;
  if (/^true(\s.*)?$/.test(t)) return true;
  if (/^:(?:\s.*)?$/.test(t)) return true;
  if (/^exit\s+0$/.test(t)) return true;
  if (t === '/bin/true' || t === '/usr/bin/true') return true;
  // Eco puro sem assert: `echo` sozinho ou `echo <texto>` (sempre no-op,
  // nunca verificação — sem chaining acima, o comando TODO é só eco).
  if (/^echo(\s+.*)?$/.test(t)) return true;
  return false;
}

export function isTaskVerified(rec: TaskEvidenceView | null | undefined): boolean {
  if (!rec) return false;
  if (isTrivialTestCommand(rec.testCommand)) return false;
  return (
    rec.testStatus === 'passed' &&
    rec.scope === 'task' &&
    Boolean(rec.reviewedCommit) &&
    !rec.acceptanceLess
  );
}
