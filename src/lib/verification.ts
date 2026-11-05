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

/**
 * TCMD: decomposição de compostos para gate de prova funcional.
 * Split em `&&`, `||` e `;` respeitando single quotes (e double por
 * segurança — `echo 'a && b'` não separa dentro de quotes). Single `|`
 * e `&` isolados NÃO são separadores (pipe/background preservados no
 * segmento e executados via `sh -c`).
 */
export function parseCompoundTestCommand(cmd: string): {
  segments: string[];
  operators: Array<'&&' | '||' | ';'>;
} {
  const segments: string[] = [];
  const operators: Array<'&&' | '||' | ';'> = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let i = 0;
  const push = () => {
    const s = cur.trim();
    if (s) segments.push(s);
    cur = '';
  };
  while (i < cmd.length) {
    const c = cmd[i]!;
    if (c === '\\' && i + 1 < cmd.length && (inSingle || inDouble)) {
      cur += c + cmd[i + 1]!;
      i += 2;
      continue;
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      cur += c;
      i += 1;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      cur += c;
      i += 1;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (cmd.startsWith('&&', i)) {
        push();
        operators.push('&&');
        i += 2;
        continue;
      }
      if (cmd.startsWith('||', i)) {
        push();
        operators.push('||');
        i += 2;
        continue;
      }
      if (c === ';') {
        push();
        operators.push(';');
        i += 1;
        continue;
      }
    }
    cur += c;
    i += 1;
  }
  push();
  return { segments, operators };
}

/** Atalho: só os segmentos (trimados, sem vazios). */
export function splitTestCommandSegments(cmd: string): string[] {
  return parseCompoundTestCommand(cmd).segments;
}

/** True quando ≥1 segmento NÃO é trivial (candidato a teste real). */
export function hasRealTestSegment(cmd?: string | null): boolean {
  if (!cmd || !cmd.trim()) return false;
  return splitTestCommandSegments(cmd).some((seg) => !isTrivialTestCommand(seg));
}

/**
 * True quando o comando TODO é só no-op (um ou vários segmentos triviais,
 * ex. `true`, `echo hi`, `true && true`). Nunca prova, mesmo com exit 0.
 */
export function isAllTrivialCompound(cmd?: string | null): boolean {
  if (!cmd || !cmd.trim()) return false;
  const segs = splitTestCommandSegments(cmd);
  if (segs.length === 0) return false;
  return segs.every((seg) => isTrivialTestCommand(seg));
}

/**
 * Contagem honesta de testes no output (bun/node genéricos).
 * Bun: `1 pass` / `0 fail`; node --test: `pass 1` / `fail 0` (`ℹ pass 1`).
 * Retorna null quando nada quantificável (chamador marca parcial, sem
 * inventar cobertura). Soma ocorrências (vários segmentos reais).
 */
export function parseTestCounts(output: string): { pass: number; fail: number } | null {
  if (!output) return null;
  // Ignora eco de comando (`$ ...`) e anotações `[TCMD]` — senão a própria
  // nota `prova via "x" (3 pass)` seria recontada ao reparsear o output final.
  const clean = output
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('[TCMD]') && !line.trimStart().startsWith('$ '))
    .join('\n');
  if (!clean.trim()) return null;
  let pass = 0;
  let fail = 0;
  let found = false;
  const rePassBefore = /(\d+)\s+pass\b/gi;
  const rePassAfter = /\bpass\s+(\d+)/gi;
  const reFailBefore = /(\d+)\s+fail\b/gi;
  const reFailAfter = /\bfail\s+(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = rePassBefore.exec(clean)) !== null) {
    pass += Number(m[1]);
    found = true;
  }
  while ((m = rePassAfter.exec(clean)) !== null) {
    pass += Number(m[1]);
    found = true;
  }
  while ((m = reFailBefore.exec(clean)) !== null) {
    fail += Number(m[1]);
    found = true;
  }
  while ((m = reFailAfter.exec(clean)) !== null) {
    fail += Number(m[1]);
    found = true;
  }
  if (!found) return null;
  return { pass, fail };
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
