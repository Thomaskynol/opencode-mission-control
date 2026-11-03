/**
 * Docs-only review criteria (lane docs2).
 *
 * Tarefas cuja entrega é só documentação nunca produzem "implementation
 * candidates" para o classificador funcional (src/lib/reviewer.ts, ramo 2b):
 * não há `export function` em `.md`, então a âncora falha para sempre e o
 * accept/retry/relaunch reconverge ao mesmo fail. Este módulo avalia essas
 * tarefas por critérios adequados ao pedido — conteúdo presente e
 * não-trivial, literais exigidos pelo aceite, cobertura das palavras-chave e
 * links relativos existentes — sem exigir teste de função quando sem sentido.
 *
 * Intencionalmente separado do reviewer: o gate funcional não é enfraquecido
 * (este caminho só é alcançado quando TODOS os arquivos do diff são
 * documentação). Docs inexistente, fora de escopo ou que não atende os
 * critérios é REJEITADA (fail fechado).
 */

export interface DocsRequirement {
  id: string;
  description: string;
}

export interface DocsAssessment {
  covered: boolean;
  reason: string;
}

const DOCS_EXTENSION_RE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
const DOCS_DIR_RE = /^(docs|doc|wiki|manual)(\/|$)/i;
const DOCS_BASENAME_RE = /^(readme|changelog|contributing|license|licence|notice|authors)(\.(md|mdx|markdown|txt|rst|adoc))?$/i;

function basenameOf(file: string): string {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  const slash = normalized.lastIndexOf('/');
  return (slash >= 0 ? normalized.slice(slash + 1) : normalized).toLowerCase();
}

/** True when a repo-relative path is documentation (extension, dir or conventional name). */
export function isDocsPath(file: string): boolean {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!normalized || normalized.includes('..')) return false;
  return (
    DOCS_EXTENSION_RE.test(normalized) ||
    DOCS_DIR_RE.test(normalized) ||
    DOCS_BASENAME_RE.test(basenameOf(normalized))
  );
}

/** True when the diff is non-empty and every touched file is documentation. */
export function isDocsOnlyChange(changedFiles: string[]): boolean {
  return changedFiles.length > 0 && changedFiles.every(isDocsPath);
}

/** Words that carry no checkable meaning in an acceptance criterion. */
const DOCS_STOPWORDS = new Set([
  'with', 'from', 'into', 'that', 'this', 'these', 'those', 'should', 'must',
  'does', 'document', 'documents', 'documented', 'documenting', 'update', 'updates',
  'updated', 'add', 'adds', 'added', 'file', 'files', 'content', 'contents',
  'containing', 'contains', 'contain', 'section', 'page', 'guide', 'readme',
  'have', 'has', 'had', 'been', 'also', 'each', 'both', 'such', 'than', 'then',
  'when', 'what', 'which', 'will', 'would', 'there', 'their', 'they', 'them',
  'como', 'para', 'com', 'uma', 'este', 'esta', 'isto', 'isso', 'aquele',
  'seja', 'sejam', 'deve', 'devem', 'cada', 'sobre', 'entre', 'pela', 'pelo',
]);

/** Minimum non-whitespace chars for a changed docs file to count as content. */
export const MIN_DOCS_CHARS = 40;

/** Extract checkable literals: backtick spans, "quoted" spans, numbers, file-like tokens. */
function extractLiterals(text: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.trim();
    if (t.length >= 2 && !out.some((e) => e.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  for (const m of text.matchAll(/`([^`]+)`/g)) push(m[1]!);
  for (const m of text.matchAll(/"([^"]{2,})"/g)) push(m[1]!);
  for (const m of text.matchAll(/\b\d+(?:\.\d+)+\b|\b\d+\b/g)) push(m[0]!);
  for (const m of text.matchAll(/[A-Za-z0-9_][A-Za-z0-9_./\\-]*\.[a-z]{1,5}\b/gi)) {
    // shortcut: file-like token heuristic — upgrade to a structured parser if it misfires.
    if (!/^(https?|ftp)$/i.test(m[0]!)) push(m[0]!);
  }
  return out.slice(0, 20);
}

/** Salient keywords: lowercase words (len>=4) minus literals and stopwords. */
function extractKeywords(description: string): string[] {
  const deliteraled = description.replace(/`[^`]*`/g, ' ').replace(/"[^"]*"/g, ' ');
  const words = deliteraled.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
  const uniq: string[] = [];
  for (const w of words) {
    if (DOCS_STOPWORDS.has(w)) continue;
    if (!uniq.includes(w)) uniq.push(w);
  }
  return uniq.slice(0, 24);
}

/** Resolve a markdown link target relative to the doc that contains it (posix). */
function resolveLinkTarget(docPath: string, target: string): string | null {
  const clean = target.split('#')[0]!.split('?')[0]!.trim();
  if (!clean) return null;
  if (/^(https?:\/\/|mailto:|data:|ftp:)/i.test(clean)) return null;
  if (clean.startsWith('/')) return clean.slice(1);
  const slash = docPath.replace(/\\/g, '/').lastIndexOf('/');
  const base = slash >= 0 ? docPath.slice(0, slash) : '';
  const parts = (base ? `${base}/${clean}` : clean).split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/');
}

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;

/**
 * Judge one acceptance requirement against examined docs content.
 * Fail-closed: no content, trivial content, missing literals/keywords or a
 * broken relative link (when the repo tree is provided) all reject.
 */
export function assessDocsCoverage(
  requirement: DocsRequirement,
  docsContents: Record<string, string>,
  opts?: { existingPaths?: string[] | Set<string> },
): DocsAssessment {
  const paths = Object.keys(docsContents);
  const fail = (reason: string): DocsAssessment => ({
    covered: false,
    reason: `docs do not cover requirement "${requirement.id}" (${requirement.description}): ${reason}`,
  });
  if (paths.length === 0) {
    return fail('no documentation content examined (missing functional evidence — stdout text alone never verifies)');
  }
  // Every changed docs file must carry real content — a placeholder diff proves nothing.
  for (const p of paths) {
    const nonWs = (docsContents[p] ?? '').replace(/\s/g, '');
    if (nonWs.length < MIN_DOCS_CHARS) {
      return fail(`"${p}" is empty or trivial (${nonWs.length} non-whitespace chars, minimum ${MIN_DOCS_CHARS}) — write the required content`);
    }
  }
  const combined = paths.map((p) => docsContents[p] ?? '').join('\n');
  const lowered = combined.toLowerCase();
  // Required literals (commands, file names, numbers, quoted spans) must appear verbatim.
  for (const lit of extractLiterals(requirement.description)) {
    if (!lowered.includes(lit.toLowerCase())) {
      return fail(`required literal "${lit}" not found in the examined docs — document it verbatim`);
    }
  }
  // Keyword majority: the prose must be about the requirement, not another topic.
  const keywords = extractKeywords(requirement.description).filter(
    (k) => !extractLiterals(requirement.description).some((l) => l.toLowerCase().includes(k)),
  );
  if (keywords.length > 0) {
    const hits = keywords.filter((k) => lowered.includes(k));
    const need = Math.max(1, Math.ceil(keywords.length / 2));
    if (hits.length < need) {
      return fail(
        `docs mention ${hits.length}/${keywords.length} required topic(s) (need ${need}: ${keywords.join('/')}) — the content is about something else`,
      );
    }
  } else if (extractLiterals(requirement.description).length === 0) {
    return fail('no checkable criterion (no literals or topic words) — refine the acceptance or accept explicitly');
  }
  // Relative links must resolve inside the reviewed tree (external/anchor links ignored).
  if (opts?.existingPaths) {
    const existing = new Set(opts.existingPaths);
    for (const p of paths) {
      LINK_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = LINK_RE.exec(docsContents[p] ?? '')) !== null) {
        const resolved = resolveLinkTarget(p, m[1]!);
        if (resolved === null) continue;
        if (!existing.has(resolved)) {
          return fail(`broken relative link in "${p}": "${m[1]}" resolves to "${resolved}" which is absent from the reviewed tree`);
        }
      }
    }
  }
  const covered: DocsAssessment = {
    covered: true,
    reason: `requirement "${requirement.id}" covered by docs: ${paths.join(', ')}`,
  };
  return covered;
}
