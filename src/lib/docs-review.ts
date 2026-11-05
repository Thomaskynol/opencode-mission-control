/**
 * Docs-only review criteria (lane docs2; lane r2-docs: heuristic auxiliary).
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
 *
 * Lane r2-docs: `assessDocsCoverage` abaixo é EVIDÊNCIA AUXILIAR apenas —
 * nunca base única para declarar `verified` um requisito que exige julgamento
 * semântico (correção factual). Uma instrução plausível porém errada passa na
 * heurística textual; o caminho público verificado é
 * `assessDocsCoverageWithSemantics` (heurística + veredito OpenCode com
 * razões e citações, fail-closed). O gate `reviewDocsOnly`
 * (src/lib/orchestrator.ts) exige o veredito semântico via esta função
 * (heurística sozinha nunca verifica julgamento semântico).
 */

import type { DocsCriterionResult } from './opencode-reviewer';

export interface DocsRequirement {
  id: string;
  description: string;
}

export interface DocsAssessment {
  covered: boolean;
  /** Dedicated outcome: covered | not-covered (explicit denial) | inconclusive (insufficient evidence, fail-closed). */
  status: DocsCoverageStatus;
  reason: string;
}

export type DocsCoverageStatus = 'covered' | 'not-covered' | 'inconclusive';

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
  // F2: doc-meta vocabulary is never evidence. A requirement demanding a
  // *relative link* is satisfied by a real markdown link to the named file;
  // a *verbatim* demand by the literal itself; a *describes* demand by
  // explanatory substance — never by these words appearing in the doc.
  // (Never code symbols: a `link()` function criterion belongs to the
  // functional gate, not here.)
  'relative', 'link', 'links', 'linked', 'linking',
  'verbatim',
  'describe', 'describes', 'described', 'describing',
  'sentence', 'sentences', 'frase', 'frases',
]);

/** Minimum non-whitespace chars for a changed docs file to count as content. */
export const MIN_DOCS_CHARS = 40;

/** M7: meta-form vocabulary about the criterion's own shape
 * (body/stamp/literal/path/upward — like the stopworded verbatim/relative/
 * link). Satisfied by the verified artifacts themselves (a present stamp,
 * a resolved link), never by the doc repeating those words. Kept separate
 * from DOCS_STOPWORDS on purpose: the drop below applies only once artifact
 * demands exist and verified, so pure-prose criteria keep the old behavior
 * and instruction detection (extras/artifacts) is untouched. */
const META_FORM_WORDS = new Set([
  'body', 'bodies', 'stamp', 'stamps', 'literal', 'literals', 'path', 'paths', 'upward',
]);

/** True when the docs carry at least one repo-relative markdown link
 * (external/anchor links ignored; resolved against the tree when given).
 * M7: a link demand naming no file ("a relative link upward to the test
 * file") still requires a real link — words alone never satisfy it. */
function docHasAnyRelativeLink(docsContents: Record<string, string>, existingPaths?: Set<string>): boolean {
  for (const [p, content] of Object.entries(docsContents)) {
    LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_RE.exec(content ?? '')) !== null) {
      const raw = (m[1] ?? '').split('#')[0]!.split('?')[0]!.trim();
      if (!raw || /^(https?:\/\/|mailto:|data:|ftp:)/i.test(raw)) continue;
      if (!existingPaths) return true;
      const resolved = resolveLinkTarget(p, m[1]!);
      if (resolved !== null && existingPaths.has(resolved)) return true;
    }
  }
  return false;
}

/** Extract checkable literals: backtick spans, "quoted" spans, numbers, file-like tokens, bare stamps. */
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
  // F2: bare verbatim stamps (`BK-5M1` demanded without backticks in the
  // acceptance) are checkable artifacts: the stamp must appear verbatim.
  // shortcut: uppercase alnum-hyphen token heuristic — upgrade if it misfires.
  for (const m of text.matchAll(/\b[A-Z0-9]{2,}(?:-[A-Z0-9]+)+\b/g)) push(m[0]!);
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
 * General denial/disclaimer signals (EN+PT, linguistic patterns — never tied
 * to a single example wording). Literals/titles/links/keywords are auxiliary
 * evidence only: a doc that mentions the topic while denying it, disclaiming
 * utility, or carrying only placeholders does NOT cover the criterion.
 * Targeted denials (denial/absence marker + criterion term in the same
 * sentence without instruction there) contradict the criterion; global
 * disclaimers (futility about the instructions themselves, TODO/TBD/
 * placeholder) void the whole doc.
 */

// Negated explanatory verbs: "does not explain/cover/describe/..." (EN, general).
const EN_NEGATED_VERB_RE =
  /\b(does\s+not|do\s+not|doesn'?t|don'?t|did\s+not|didn'?t|will\s+not|won'?t|can\s+not|cannot|can'?t|could\s+not|couldn'?t|would\s+not|wouldn'?t|has\s+not|have\s+not|hasn'?t|haven'?t|never|fails?\s+to|failed\s+to|unable\s+to|not\s+yet|no\s+longer)\b[^.!?\n]{0,120}\b(explain|explains|explained|explaining|cover|covers|covered|covering|coverage|describe|describes|described|describing|document|documents|documented|documenting|detail|details|detailed|detailing|include|includes|included|including|provide|provides|provided|providing|contain|contains|contained|containing|address|addresses|addressed|show|shows|shown|demonstrate|demonstrates|guide|guides|instruct|instructs|tell|tells)\b/i;

// Same shape in PT: "não explica/cobre/descreve/documenta/..." (general).
const PT_NEGATED_VERB_RE =
  /\bn[ãa]o\b[^.!?\n]{0,120}\b(explica|explicam|explicar|explicado|explicada|cobre|cobrem|cobrir|coberto|coberta|descreve|descrevem|descrever|descrito|descrita|documenta|documentam|documentar|documentado|detalha|detalham|detalhar|detalhado|detalhada|inclui|incluem|incluir|inclu[íi]do|inclu[íi]da|cont[ée]m|conter|contido|aborda|abordam|abordar|abordado|apresenta|apresentam|apresentar|apresentado|ensina|ensinam|ensinar|mostra|mostram|mostrar|traz|trazem|trazer)\b/i;

// Placeholders void the doc wherever they appear (general list, EN+PT).
const GLOBAL_PLACEHOLDER_RE =
  /\b(todo|tbd|t\.b\.d\.|fixme|xxx|placeholder|lorem\s+ipsum|under\s+construction|coming\s+soon|to\s+be\s+written|work\s+in\s+progress|not\s+yet\s+written|a\s+ser\s+definido|a\s+definir|por\s+definir|em\s+constru[çc][ãa]o|em\s+breve|pendente|rascunho|por\s+fazer)\b/i;

// Futility about the instructions themselves (general, EN+PT): nobody can use
// them, no/ missing instructions, out of scope — the doc disclaims its own utility.
const GLOBAL_FUTILITY_RES: RegExp[] = [
  /\b(nobody|no\s+one)\b[^.!?\n]{0,100}\b(recover|restore|use|using|follow|following|instructions?|steps?|guide)\b/i,
  /\b(no\s+instructions?|without\s+instructions?|missing\s+instructions?|instructions?\s+missing|out\s+of\s+scope|not\s+included|not\s+provided)\b/i,
  /\b(cannot|can'?t|won'?t|will\s+not|unable|impossible|not\s+possible)\b[^.!?\n]{0,60}\b(recover|restore|use|using|follow)\b/i,
  /\bningu[ée]m\b[^.!?\n]{0,80}\b(consegue|pode|recupera|restaura|usar|seguir|instru)/i,
  /\bn[ãa]o\s+[ée]\s+poss[íi]vel\b[^.!?\n]{0,60}\b(recuperar|restaurar|usar|seguir)\b/i,
  /\bsem\s+instru[çc][oõ]es\b/i,
  /\bsem\s+detalhes\b/i,
  /\bfora\s+do\s+escopo\b/i,
  /\bn[ãa]o\s+inclu[íi]do/i,
];

// Procedural/instructional verbs (EN+PT, general). Word boundaries are
// Unicode-aware (ASCII \b splits "restauração" into "restaura"+..., so a
// mention would fake an instruction); only whole words count as verbs.
const WORD_CH = 'A-Za-zÀ-ú0-9_';
const PROCEDURAL_VERB_SRC =
  'run|runs|running|execute|executes|executing|open|opens|click|clicks|type|types|enter|enters|install|installs|configure|configures|create|creates|copy|copies|paste|save|saves|restore|restores|restoring|recover|recovers|recovering|select|selects|choose|chooses|follow|follows|following|use|uses|using|set|sets|add|adds|remove|removes|delete|deletes|update|updates|verify|verifies|check|checks|ensure|ensures|restart|reboot|connect|connects|download|downloads|upload|uploads|extract|extracts|mount|start|starts|stop|stops|enable|enables|disable|disables|navigate|press|invoke|call|calls|edit|modify|fetch|fetches|perform|see|sees|refer|refers|rode|rodar|abra|abre|abrir|clique|clica|clicar|digite|digita|digitar|instale|instala|instalar|configura|configurar|crie|cria|criar|copie|copia|copiar|cole|cola|colar|salve|salva|salvar|restaure|restaura|restaurar|recupere|recupera|recuperar|selecione|seleciona|selecionar|escolha|escolhe|escolher|siga|segue|seguir|usar|defina|define|definir|adicione|adiciona|adicionar|remova|remover|exclua|exclui|excluir|atualize|atualiza|atualizar|verifique|verifica|verificar|reinicie|reinicia|reiniciar|conecte|conecta|conectar|baixe|baixa|baixar|extraia|extrai|extrair|inicie|inicia|iniciar|habilite|desabilite|navegue|pressione|edite|modifique|consulte|veja|acesse';
const PROCEDURAL_VERB_RE = new RegExp(`(?<![${WORD_CH}])(?:${PROCEDURAL_VERB_SRC})(?![${WORD_CH}])`, 'i');

// General denial/disclaimer markers (EN+PT classes, never example phrases):
// negation (not/n't/no/never/.../não/nunca/jamais...), absence (without/missing/
// lacking/absent/sem/falta/fora/ausente...) and exclusion (except/outside/fora
// de/out of...). Used only together with criterion overlap + no instruction in
// the same sentence, so "without downtime, run..." (with instruction) still passes.
const DENIAL_MARKER_RE = new RegExp(
  `(?:(?<![${WORD_CH}])(?:not|no|never|neither|nor|without|missing|lacking|absent|excluded|outside|except|fails?|failed|denied|denies|void|n[ãa]o|nunca|jamais|sem|ausentes?|falta|faltando|faltam|fora|exclu[íi]dos?|nada)(?![${WORD_CH}])|n\\'t(?![${WORD_CH}])|(?<![${WORD_CH}])fora\\s+de(?![${WORD_CH}])|(?<![${WORD_CH}])out\\s+of(?![${WORD_CH}]))`,
  'i',
);

function splitSentences(text: string): string[] {
  // Backtick-aware AND paren-aware: dots inside `code spans` (commands,
  // paths, versions) and inside `(...)` groups (link targets like
  // `../slug.test.mjs`, calls like `mean([1,2])`) are not sentence
  // boundaries — splitting there shatters one instruction into fragments
  // that prove nothing (or hide a contradiction). Paren depth resets on
  // newline (sentences never span lines here); unbalanced closers clamp.
  const out: string[] = [];
  let cur = '';
  let inCode = false;
  let parenDepth = 0;
  const flush = () => {
    const s = cur.trim().replace(/^#+\s*/, '');
    if (s.length > 0) out.push(s);
    cur = '';
    parenDepth = 0;
  };
  for (const ch of text) {
    if (ch === '`') inCode = !inCode;
    if (!inCode && ch === '(') parenDepth++;
    if (!inCode && ch === ')' && parenDepth > 0) parenDepth--;
    if (!inCode && parenDepth === 0 && (ch === '.' || ch === '!' || ch === '?' || ch === '\n' || ch === ';')) {
      flush();
    } else {
      cur += ch;
    }
  }
  flush();
  return out;
}

function sentenceMentionsCriterion(sentenceLower: string, keywords: string[], literals: string[]): boolean {
  for (const k of keywords) {
    if (k.length >= 4 && sentenceLower.includes(k)) return true;
  }
  for (const lit of literals) {
    const l = lit.toLowerCase();
    if (l.length >= 4 && sentenceLower.includes(l)) return true;
  }
  return false;
}

function isNegatedSentence(sentence: string): boolean {
  return EN_NEGATED_VERB_RE.test(sentence) || PT_NEGATED_VERB_RE.test(sentence);
}

function isGlobalDisclaimerSentence(sentence: string): boolean {
  if (GLOBAL_PLACEHOLDER_RE.test(sentence)) return true;
  return GLOBAL_FUTILITY_RES.some((re) => re.test(sentence));
}

function extrasOf(sentence: string, kwLower: string[], litLower: string[]): Set<string> {
  const extras = new Set<string>();
  for (const w of sentence.toLowerCase().match(/[a-zà-ú0-9]{4,}/g) ?? []) {
    if (DOCS_STOPWORDS.has(w)) continue;
    if (kwLower.includes(w)) continue;
    if (litLower.some((l) => l.includes(w))) continue;
    extras.add(w);
  }
  return extras;
}

function sentenceHasInstruction(sentence: string, kwLower: string[], litLower: string[], criterionVerbs: string[] = [], minExtras = 2): boolean {
  // A verb that merely restates a criterion keyword (same word family:
  // "restore" for required "restoration") adds no instruction of its own —
  // only a verb OUTSIDE the criterion's vocabulary counts. An exact
  // (case-insensitive) copy of the criterion's own verb counts as a copy
  // even when short (run/use/set) — it carries no new instruction.
  const verbs = sentence.match(new RegExp(PROCEDURAL_VERB_RE.source, 'gi')) ?? [];
  const addsInstruction = verbs.some((v) => !isKeywordCopyVerb(v, kwLower, criterionVerbs));
  return addsInstruction && extrasOf(sentence, kwLower, litLower).size >= minExtras;
}

/** True when the sentence carries a markdown link to a demanded file
 * literal (`[text](../slug.test.mjs)`). F2: the link structure is itself
 * checkable detail — the target words are the criterion's own vocabulary
 * (excluded from extras by design), so a bare "See [..](file)" would
 * otherwise never count as instruction despite verb + artifact. */
function sentenceHasDemandLink(sentence: string, litLower: string[]): boolean {
  const files = litLower.filter((l) => l.length >= 4 && /\.[a-z]{1,5}$/.test(l));
  if (files.length === 0) return false;
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(sentence)) !== null) {
    const target = (m[1] ?? '').toLowerCase();
    if (files.some((f) => target.includes(f))) return true;
  }
  return false;
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function isKeywordCopyVerb(verb: string, kwLower: string[], criterionVerbs: string[] = []): boolean {
  const v = verb.toLowerCase();
  if (criterionVerbs.includes(v)) return true;
  if (v.length < 5) return false;
  return kwLower.some((k) => k.length >= 5 && commonPrefixLen(v, k) >= 5);
}

/** Procedural verbs appearing in the criterion itself (lowercase, any length) —
 *  the criterion's own wording, used only for the copy-verb check (never for gates). */
function extractCriterionVerbs(description: string): string[] {
  const out: string[] = [];
  for (const m of description.match(new RegExp(PROCEDURAL_VERB_RE.source, 'gi')) ?? []) {
    const v = m.toLowerCase();
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Concrete checkable detail inside one sentence (general shapes, never
 * topic words): inline code, a path, a number/version, or an explicit
 * step marker. Bare prose verbs without any of these are shape without
 * substance — any fluent nonsense passes a verb-only check.
 */
const STEP_MARKER_RE = new RegExp(
  `(?:^|[\\s(])(?:\\d+[.)]|step\\s*\\d+|etapa\\s*\\d+|passo\\s*\\d+)\\b`,
  'i',
);

/** File-like literal (has a source/doc extension). */
function isFileLikeToken(lit: string): boolean {
  return /\.[a-z]{1,5}$/i.test(lit.trim());
}

/** True when a required literal names the examined doc itself
 * (`docs/stats.md` demanded of `docs/stats.md`). F2: self-mention is not
 * evidence — the file being among the examined docs IS the evidence. */
function isSelfPathLiteral(lit: string, paths: string[]): boolean {
  const norm = lit.trim().replace(/^\.\//, '');
  return paths.some((p) => {
    const pn = p.trim().replace(/^\.\//, '');
    if (pn === norm || pn.toLowerCase() === norm.toLowerCase()) return true;
    const base = pn.split('/').pop() ?? '';
    if (!norm.includes('/') && base.toLowerCase() === norm.toLowerCase()) return true;
    return false;
  });
}

/** True when the docs carry a real markdown link to `file`
 * (`[text](../stats.test.mjs)`), resolved against the reviewed tree when
 * the tree is provided. F2: the link artifact — never the words
 * "relative"/"link" — satisfies a link demand. */
function docHasLinkTo(
  docsContents: Record<string, string>,
  file: string,
  existingPaths?: Set<string>,
): boolean {
  const want = file.trim().toLowerCase();
  for (const [p, content] of Object.entries(docsContents)) {
    LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_RE.exec(content ?? '')) !== null) {
      const raw = (m[1] ?? '').split('#')[0]!.split('?')[0]!.trim();
      if (!raw) continue;
      if (/^(https?:\/\/|mailto:|data:|ftp:)/i.test(raw)) continue;
      const norm = raw.replace(/^\.\//, '').toLowerCase();
      if (!norm.includes(want) && !want.includes(norm)) continue;
      if (!existingPaths) return true;
      const resolved = resolveLinkTarget(p, m[1]!);
      if (resolved !== null && existingPaths.has(resolved)) return true;
    }
  }
  return false;
}

function sentenceHasConcreteDetail(sentence: string): boolean {
  if (/`[^`]+`/.test(sentence)) return true;
  if (/\S+\/\S+/.test(sentence)) return true;
  if (/\b\d/.test(sentence)) return true;
  if (STEP_MARKER_RE.test(sentence)) return true;
  return false;
}

// A negated instruction ("never run X", "do not delete Y", "não execute Z"):
const NEGATED_INSTRUCTION_RE = new RegExp(
  `(?:(?<![${WORD_CH}])(?:never|do\\s+not|don\\'t|does\\s+not|doesn\\'t|did\\s+not|didn\\'t|cannot|can\\'t|will\\s+not|won\\'t|n[ãa]o|nunca|jamais|sem)(?![${WORD_CH}]))[^.!?\\n]{0,40}(?<![${WORD_CH}])(?:${PROCEDURAL_VERB_SRC})(?![${WORD_CH}])`,
  'i',
);

/** Checkable artifacts anchoring a sentence: code spans (whole + inner
 * words, so `restore.sh` matches `restore.sh --from backup.tar.gz`),
 * paths, numbers. */
function sentenceArtifacts(sentence: string): Set<string> {
  const out = new Set<string>();
  const lower = sentence.toLowerCase();
  for (const m of lower.matchAll(/`([^`]+)`|(\S+\/\S+)|\b\d+(?:\.\d+)*\b/g)) {
    if (m[0]!.startsWith('`')) {
      out.add(m[0]!);
      for (const w of m[1]!.match(/[a-zà-ú0-9]{4,}/g) ?? []) {
        if (!DOCS_STOPWORDS.has(w)) out.add(w);
      }
    } else {
      out.add(m[0]!);
    }
  }
  return out;
}

/**
 * Internal contradiction (general, artifact-anchored): one sentence negates
 * an instruction about the same checkable artifact another sentence gives
 * ("run `restore.sh`" vs "never run `restore.sh`"). Word patterns cannot
 * settle which side is right, so this is at minimum inconclusive
 * fail-closed — never covered.
 */
function findContradiction(
  sentences: string[],
  keywords: string[] = [],
  literals: string[] = [],
  criterionVerbs: string[] = [],
): string | null {
  const arts = sentences.map(sentenceArtifacts);
  for (let i = 0; i < sentences.length; i++) {
    if (!NEGATED_INSTRUCTION_RE.test(sentences[i]!)) continue;
    for (let j = 0; j < sentences.length; j++) {
      if (i === j || arts[j]!.size === 0) continue;
      const shared = [...arts[i]!].filter((a) => arts[j]!.has(a));
      if (shared.length > 0) return `"${sentences[i]!.slice(0, 120)}" contradicts "${sentences[j]!.slice(0, 120)}"`;
    }
  }
  // Fail-closed without a shared artifact: a negated instruction about the
  // criterion plus another instructive sentence about the criterion pull in
  // opposite directions — word patterns cannot settle it, never covered.
  const kwLower = keywords.map((k) => k.toLowerCase());
  const litLower = literals.map((l) => l.toLowerCase()).filter((l) => l.length >= 4);
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i]!;
    if (!NEGATED_INSTRUCTION_RE.test(s)) continue;
    if (!sentenceMentionsCriterion(s.toLowerCase(), keywords, literals)) continue;
    for (let j = 0; j < sentences.length; j++) {
      if (i === j) continue;
      const o = sentences[j]!;
      if (!sentenceMentionsCriterion(o.toLowerCase(), keywords, literals)) continue;
      if (!sentenceHasInstruction(o, kwLower, litLower, criterionVerbs)) continue;
      return `"${s.slice(0, 120)}" contradicts "${o.slice(0, 120)}" (no shared artifact — fail-closed)`;
    }
  }
  return null;
}

/**
 * Affirmative explanatory substance: instructive sentences (procedural verb
 * beyond the criterion's own vocabulary + new informative words).
 * Descriptive-only prose without instruction is inconclusive fail-closed
 * (human/external decides, never auto-pass).
 */
function qualifyingInstructionSentences(combined: string, keywords: string[], literals: string[], criterionVerbs: string[] = []): string[] {
  const found: string[] = [];
  const kwLower = keywords.map((k) => k.toLowerCase());
  const litLower = literals.map((l) => l.toLowerCase()).filter((l) => l.length >= 4);
  for (const raw of splitSentences(combined)) {
    const s = raw.trim();
    if (s.length < 20) continue; // titles/fragments alone prove nothing
    if (isGlobalDisclaimerSentence(s)) continue;
    if (isNegatedSentence(s)) continue;
    if (DENIAL_MARKER_RE.test(s) && sentenceMentionsCriterion(s.toLowerCase(), keywords, literals)) continue;
    const words3 = s.toLowerCase().match(/[a-zà-ú0-9]{3,}/g) ?? [];
    if (words3.length < 5) continue;
    // F2: a sentence linking a demanded file carries the artifact as its
    // detail — one fresh word beside the link suffices (the target words
    // are the criterion's own vocabulary, excluded from extras by design).
    const minExtras = sentenceHasDemandLink(s, litLower) ? 1 : 2;
    if (sentenceHasInstruction(s, kwLower, litLower, criterionVerbs, minExtras)) found.push(s);
  }
  return found;
}


/**
 * Judge one acceptance requirement against examined docs content.
 * HEURISTIC AUXILIARY ONLY (lane r2-docs): never the sole basis for
 * `verified` when semantic judgment is required — a plausible but factually
 * wrong instruction passes here. The verified public path is
 * `assessDocsCoverageWithSemantics` below. Fail-closed: no content, trivial
 * content, explicit denial/disclaimer, missing literals/keywords, broken
 * links, or missing explanatory substance all reject. Literals/titles/links/
 * keywords are auxiliary evidence only — coverage requires affirmative
 * explanatory substance about the criterion. When substance is absent without
 * explicit denial, the result is `inconclusive` (uncertainty, fail-closed:
 * external reviewer or explicit human accept required, never auto-pass).
 */
export function assessDocsCoverage(
  requirement: DocsRequirement,
  docsContents: Record<string, string>,
  opts?: { existingPaths?: string[] | Set<string>; auxContents?: Record<string, string> },
): DocsAssessment {
  const paths = Object.keys(docsContents);
  const failNotCovered = (reason: string): DocsAssessment => ({
    covered: false,
    status: 'not-covered',
    reason: `docs do not cover requirement "${requirement.id}" (${requirement.description}): ${reason}`,
  });
  const failInconclusive = (reason: string): DocsAssessment => ({
    covered: false,
    status: 'inconclusive',
    reason: `docs assessment inconclusive for requirement "${requirement.id}" (${requirement.description}): ${reason} — fail-closed: requires external reviewer or explicit human accept, never auto-pass`,
  });
  if (paths.length === 0) {
    return failNotCovered('no documentation content examined (missing functional evidence — stdout text alone never verifies)');
  }
  // Every changed docs file must carry real content — a placeholder diff proves nothing.
  for (const p of paths) {
    const nonWs = (docsContents[p] ?? '').replace(/\s/g, '');
    if (nonWs.length < MIN_DOCS_CHARS) {
      return failNotCovered(`"${p}" is empty or trivial (${nonWs.length} non-whitespace chars, minimum ${MIN_DOCS_CHARS}) — write the required content`);
    }
  }
  const combined = paths.map((p) => docsContents[p] ?? '').join('\n');
  const lowered = combined.toLowerCase();
  const literals = extractLiterals(requirement.description);
  const keywords = extractKeywords(requirement.description).filter(
    (k) => !literals.some((l) => l.toLowerCase().includes(k)),
  );
  const criterionVerbs = extractCriterionVerbs(requirement.description);
  const existingSet = opts?.existingPaths
    ? new Set(Array.isArray(opts.existingPaths) ? opts.existingPaths : [...opts.existingPaths])
    : undefined;
  // F2: existence-only claims ("docs/stats.md exists") are satisfied by the
  // file being among the examined docs (or the reviewed tree) — never by
  // the doc naming itself.
  {
    const withoutExist = keywords.filter((k) => k !== 'exists' && k !== 'exist' && k !== 'existence');
    if (
      /\bexists?\b/i.test(requirement.description) &&
      withoutExist.length === 0 &&
      literals.length > 0 &&
      literals.every(isFileLikeToken)
    ) {
      for (const lit of literals) {
        const present =
          isSelfPathLiteral(lit, paths) ||
          (existingSet !== undefined &&
            [...existingSet].some(
              (p) => p === lit || p.endsWith(`/${lit}`) || p.toLowerCase() === lit.toLowerCase(),
            ));
        if (!present) {
          return failNotCovered(
            `required file "${lit}" is not among the examined docs or the reviewed tree — create it or fix the criterion`,
          );
        }
      }
      return {
        covered: true,
        status: 'covered',
        reason: `requirement "${requirement.id}" covered by docs: ${paths.join(', ')}`,
      };
    }
  }
  // Global disclaimers void the whole doc (general patterns, EN+PT).
  for (const raw of splitSentences(combined)) {
    if (isGlobalDisclaimerSentence(raw)) {
      return failNotCovered(
        `docs disclaim their own utility ("${raw.slice(0, 120)}") — placeholder or futility disclaimer voids coverage, write real instructions or accept explicitly`,
      );
    }
  }
  // Targeted denial (general, verb-independent): a sentence with a denial/
  // absence marker about the criterion itself contradicts it when that same
  // sentence carries no affirmative instruction. Negations about unrelated
  // topics, or markers inside an instructive sentence, do not block.
  for (const raw of splitSentences(combined)) {
    const lower = raw.toLowerCase();
    if (!sentenceMentionsCriterion(lower, keywords, literals)) continue;
    if (isNegatedSentence(raw)) {
      return failNotCovered(
        `docs deny coverage ("${raw.slice(0, 140)}") — content contradicts the criterion, fix the docs or accept explicitly`,
      );
    }
    if (DENIAL_MARKER_RE.test(raw)) {
      const kwLower = keywords.map((k) => k.toLowerCase());
      const litLower = literals.map((l) => l.toLowerCase()).filter((l) => l.length >= 4);
      if (!sentenceHasInstruction(raw, kwLower, litLower, criterionVerbs)) {
        return failNotCovered(
          `docs deny coverage ("${raw.slice(0, 140)}") — content contradicts the criterion, fix the docs or accept explicitly`,
        );
      }
    }
  }
  // Required literals (commands, file names, numbers, quoted spans, stamps)
  // must appear verbatim. Auxiliary only: presence never proves coverage,
  // absence rejects. F2: a literal naming the examined doc itself is
  // satisfied by the file's presence (self-mention proves nothing).
  for (const lit of literals) {
    if (isSelfPathLiteral(lit, paths)) continue;
    if (!lowered.includes(lit.toLowerCase())) {
      return failNotCovered(`required literal "${lit}" not found in the examined docs — document it verbatim`);
    }
  }
  // F2: link demands ("relative link ... containing F") are satisfied by a
  // real markdown link to F — never by the words "relative"/"link".
  // M7: a link demand naming no file ("a relative link upward to the test
  // file") still requires a real relative link — words alone never do.
  if (/\blink(s|ed|ing)?\b/i.test(requirement.description)) {
    const demanded = literals.filter(isFileLikeToken).filter((f) => !isSelfPathLiteral(f, paths));
    for (const f of demanded) {
      if (!docHasLinkTo(docsContents, f, existingSet)) {
        return failNotCovered(
          `no relative link to "${f}" found in the examined docs — add a markdown link such as [text](../${f}) resolving inside the reviewed tree`,
        );
      }
    }
    if (demanded.length === 0 && !docHasAnyRelativeLink(docsContents, existingSet)) {
      return failNotCovered(
        'no relative link found in the examined docs — add a markdown link to the test file resolving inside the reviewed tree',
      );
    }
  }
  // M7: meta-form words (body/stamp/literal/path/upward) describe the
  // criterion's own shape — the artifacts above already verified them, so
  // the doc never needs to repeat them. Drop them from the majority once
  // artifact demands exist and verified; the majority then still vetoes
  // genuinely off-topic content via the remaining topic words, and
  // mention-without-artifact still fails at the gates above. Pure-prose
  // criteria (no artifact demands) keep the old behavior.
  const hasArtifactDemands =
    literals.length > 0 || /\blink(s|ed|ing)?\b/i.test(requirement.description);
  const topicKeywords =
    hasArtifactDemands && keywords.some((k) => META_FORM_WORDS.has(k))
      ? keywords.filter((k) => !META_FORM_WORDS.has(k))
      : keywords;
  // Keyword majority: the prose must be about the requirement, not another topic.
  // Auxiliary only: mention without explanation never passes (see substance below).
  if (topicKeywords.length > 0) {
    const hits = topicKeywords.filter((k) => lowered.includes(k));
    const need = Math.max(1, Math.ceil(topicKeywords.length / 2));
    if (hits.length < need) {
      return failNotCovered(
        `docs mention ${hits.length}/${topicKeywords.length} required topic(s) (need ${need}: ${topicKeywords.join('/')}) — the content is about something else`,
      );
    }
  } else if (literals.length === 0) {
    return failInconclusive('no checkable criterion (no literals or topic words) — refine the acceptance or accept explicitly');
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
          return failNotCovered(`broken relative link in "${p}": "${m[1]}" resolves to "${resolved}" which is absent from the reviewed tree`);
        }
      }
    }
  }
  // F2: consistency demands ("consistent(ly) with code/test") are settled
  // against real sibling artifacts — never by vocabulary. When read-only
  // sibling contents are provided, the doc's checkable decision literals
  // (backtick spans, numbers) in topic sentences must share at least one
  // literal with the siblings; a doc claiming a decision the code never
  // shows is rejected. Without siblings the check abstains (unknown) and
  // the gates below decide — an unverifiable consistency stays
  // inconclusive fail-closed, never covered on prose alone.
  // shortcut: shared-literal heuristic — upgrade to a semantic verdict if it misfires.
  if (/consisten/i.test(requirement.description) && opts?.auxContents) {
    const auxCombined = Object.values(opts.auxContents).join('\n').toLowerCase();
    if (auxCombined.trim().length > 0) {
      const topicLits: string[] = [];
      for (const raw of splitSentences(combined)) {
        if (!sentenceMentionsCriterion(raw.toLowerCase(), topicKeywords, literals)) continue;
        for (const m of raw.matchAll(/`([^`]+)`/g)) {
          const t = (m[1] ?? '').trim();
          if (t.length >= 2 && !topicLits.some((e) => e.toLowerCase() === t.toLowerCase())) topicLits.push(t);
        }
        for (const m of raw.matchAll(/\b\d+(?:\.\d+)?\b/g)) {
          if (!topicLits.some((e) => e.toLowerCase() === m[0]!.toLowerCase())) topicLits.push(m[0]!);
        }
      }
      if (topicLits.length > 0) {
        const shared = topicLits.filter((l) => auxCombined.includes(l.toLowerCase()));
        if (shared.length === 0) {
          return failNotCovered(
            `docs state a decision (${topicLits.slice(0, 3).join('/')} ) the sibling artifacts never show — fix the docs to match the code/tests or accept explicitly`,
          );
        }
      }
    }
  }
  // Internal contradiction voids coverage (at minimum inconclusive, fail-closed).
  const contradiction = findContradiction(
    splitSentences(combined).map((s) => s.trim()).filter((s) => s.length > 0),
    topicKeywords,
    literals,
    criterionVerbs,
  );
  if (contradiction) {
    return failInconclusive(`docs contradict themselves (${contradiction}) — word patterns cannot settle which side is right`);
  }
  // Substance gate: mention is not explanation. With required literals, the
  // literal plus an instructive sentence is verifiable substance. Without
  // literals (broad criteria), only an instructive sentence ABOUT the
  // criterion carrying concrete checkable detail counts — a single vague
  // sentence, or plausible-but-unverifiable prose, is inconclusive
  // fail-closed (never auto-pass, never "covered" on shape alone).
  const instructions = qualifyingInstructionSentences(combined, topicKeywords, literals, criterionVerbs);
  const verified =
    literals.length > 0
      ? instructions.length > 0
      : instructions.some(
          (s) => sentenceMentionsCriterion(s.toLowerCase(), topicKeywords, literals) && sentenceHasConcreteDetail(s),
        );
  if (!verified) {
    return failInconclusive(
      `docs mention the topic but provide no verifiable affirmative substance (no instructive sentence with concrete checkable detail — only vague prose, repetition, titles, or disclaimed text found)`,
    );
  }
  const covered: DocsAssessment = {
    covered: true,
    status: 'covered',
    reason: `requirement "${requirement.id}" covered by docs: ${paths.join(', ')}`,
  };
  return covered;
}

/** Semantic input for the verified path: reviewer verdict + reasons + doc citations. */
export type DocsSemanticInput = Pick<DocsCriterionResult, 'verdict' | 'reason' | 'evidence'> & {
  demonstrated?: boolean;
};

const VERIFIED_UNCERTAINTY_RE =
  /\b(unclear|uncertain|unknown|cannot\s+(determine|verify|confirm)|insufficient\s+evidence|not\s+sure|ambiguous|possibly|might\s+be)\b/i;

const VERIFIED_CONTRADICTS_PASS_RE =
  /\b(incorrect|wrong|false|missing|fails?\s+to|contradicts?|destructive|harmful|does\s+not\s+(satisfy|meet|cover|explain|describe))\b/i;

// ---------------------------------------------------------------------------
// Docs executed evidence (k2/req-4): docs-only gate never executes the suite,
// so a criterion demanding proof of execution ("node --test passes") can never
// be satisfied by prose alone — even correct docs fail without a linked
// product-executed run. Optional channel, captured by the product (never
// alleged by the worker), validated with the functional gate identity rules.
// shortcut: keyword/runner heuristic — upgrade to a structured parser if it misfires.

/** Product-captured execution proof linked to a docs-only requirement. */
export interface DocsExecutedEvidence {
  command: string;
  exitCode: number;
  output: string;
  testedCommit: string;
  environment?: string;
  dirty?: boolean;
  taskHead?: string;
  candidateBase?: string;
  candidateHead?: string;
}

/** True when the criterion demands proof of test execution (not docs about it). */
export function isExecutionRequirement(description: string): boolean {
  const d = description.toLowerCase();
  // Docs framing ("documents/explains ... running tests") is never execution proof.
  if (/\b(documents?|documenting|explains?|describes?|contains?|body|guide|readme)\b/.test(d)) return false;
  const runner = /(node\s+--test|bun\s+test|npm\s+(test|run)|yarn\s+test|pnpm\s+test|pytest|go\s+test|cargo\s+test|vitest|jest)/i.test(
    description,
  );
  const passSignal = /\bpass(es|ed)?\b|\bgreen\b|\bexit\s*0\b|\bsucceeds?\b|\bsuccessful/i.test(description);
  if (runner && passSignal) return true;
  if (/\btests?\s+pass|\bsuite\s+pass(es|ed)?\b/i.test(d)) return true;
  return false;
}

/** Best-effort runner command named by an execution criterion (for product re-run). */
export function inferExecutionCommand(description: string): string | null {
  const m = description.match(/(node\s+--test\b|bun\s+test\b|npm\s+test\b|yarn\s+test\b|pnpm\s+test\b|pytest\b|go\s+test\b|cargo\s+test\b)/i);
  return m ? m[1]!.trim() : null;
}

export function validateDocsExecutedEvidence(
  evidence: DocsExecutedEvidence | null | undefined,
  jobHead: string,
): { ok: boolean; reason: string } {
  const head = (jobHead ?? '').trim();
  if (!evidence) {
    return {
      ok: false,
      reason:
        'missing executed evidence: no product-executed test run linked to this execution criterion — execute e reapresente (docs content alone does not prove execution; no docs rewrite requested for this failure)',
    };
  }
  if (!head) {
    return { ok: false, reason: 'missing executed evidence: job HEAD unknown — execute e reapresente' };
  }
  if (!evidence.command || !evidence.command.trim()) {
    return { ok: false, reason: 'invalid executed evidence: missing test command — re-execute e re-review' };
  }
  if (evidence.exitCode !== 0) {
    return {
      ok: false,
      reason: `executed evidence reports failure (exit ${evidence.exitCode} for "${evidence.command}") — re-execute e re-review`,
    };
  }
  if (!evidence.output || !evidence.output.trim()) {
    return { ok: false, reason: 'invalid executed evidence: missing observable test output — re-execute e re-review' };
  }
  if (!evidence.environment || !evidence.environment.trim()) {
    return {
      ok: false,
      reason: 'invalid executed evidence: missing execution environment (cannot tell observed product execution from declared text) — re-execute e re-review',
    };
  }
  if (!evidence.testedCommit || !evidence.testedCommit.trim()) {
    return { ok: false, reason: 'invalid executed evidence: missing tested commit — re-execute e re-review' };
  }
  if (evidence.taskHead !== undefined || evidence.candidateBase !== undefined || evidence.candidateHead !== undefined) {
    if (!evidence.candidateHead || !evidence.candidateHead.trim()) {
      return { ok: false, reason: 'invalid executed evidence: missing candidate identity (observed candidate HEAD) — re-execute e re-review' };
    }
    if (evidence.testedCommit !== evidence.candidateHead) {
      return {
        ok: false,
        reason: `stale executed evidence: testedCommit ${evidence.testedCommit} is not the observed candidate ${evidence.candidateHead} — re-execute e re-review`,
      };
    }
    if (!evidence.taskHead || evidence.taskHead !== head) {
      return {
        ok: false,
        reason: `stale executed evidence: candidate does not contain the reviewed job (taskHead ${evidence.taskHead ?? '(missing)'} vs job HEAD ${head}) — re-execute e re-review`,
      };
    }
  } else if (evidence.testedCommit !== head) {
    return {
      ok: false,
      reason: `stale executed evidence: tested code diverges (evidence covers ${evidence.testedCommit} but job HEAD is ${head}) — re-execute e re-review`,
    };
  }
  if (evidence.dirty) {
    return { ok: false, reason: 'dirty executed evidence: tested tree was dirty (uncommitted changes) — re-execute e re-review' };
  }
  return { ok: true, reason: '' };
}

/** Semantic fail solely about missing output/result proof in the docs (execution supplied by evidence). */
const EXEC_OUTPUT_LACK_RE =
  /no test execution output|without .*output|missing .*output|contains no .*output|contains no .*result|no .*result.*prov|execution .*proof|proving .*pass/i;

/**
 * Verified public path (lane r2-docs): heuristic auxiliary + semantic verdict.
 *
 * Heuristic (`assessDocsCoverage`) rejects definitively on `not-covered`
 * (denial, missing literals, broken links, trivial/empty) — semantic never
 * overrides those. Otherwise verified (`covered`) requires ALL of:
 * semantic present, verdict `pass`, `demonstrated` true when present,
 * non-empty `evidence` (verbatim doc quotes), reason with no uncertainty
 * (`unclear`, …) and no self-contradiction (pass + “incorrect/wrong/…”).
 * Anything else — missing/malformed reviewer output, `fail`,
 * `inconclusive`, empty evidence, uncertainty, contradiction, or a heuristic
 * internal contradiction — resolves to `not-covered` (explicit semantic
 * fail) or `inconclusive` (uncertainty, fail-closed: external re-review or
 * explicit human accept, never auto-pass). Never throws.
 *
 * Ligado em `reviewDocsOnly` (src/lib/orchestrator.ts), que chama esta
 * função com o resultado de `reviewDocsViaOpenCode`
 * (src/lib/opencode-reviewer.ts) no modelo efetivo autorizado
 * (`opencode-go/muse-spark-1.3-contributor` por padrão). `covered` da
 * heurística sozinha NUNCA é `verified`.
 */
export function assessDocsCoverageWithSemantics(
  requirement: DocsRequirement,
  docsContents: Record<string, string>,
  semantic: DocsSemanticInput | null | undefined,
  opts?: {
    existingPaths?: string[] | Set<string>;
    auxContents?: Record<string, string>;
    executedEvidence?: DocsExecutedEvidence | null;
    jobHead?: string;
  },
): DocsAssessment {
  const heuristic = assessDocsCoverage(requirement, docsContents, opts);
  const failNotCovered = (reason: string): DocsAssessment => ({
    covered: false,
    status: 'not-covered',
    reason: `docs do not cover requirement "${requirement.id}" (${requirement.description}): ${reason}`,
  });
  const failInconclusive = (reason: string): DocsAssessment => ({
    covered: false,
    status: 'inconclusive',
    reason: `docs assessment inconclusive for requirement "${requirement.id}" (${requirement.description}): ${reason} — fail-closed: requires external reviewer or explicit human accept, never auto-pass`,
  });
  const execRequired = isExecutionRequirement(requirement.description);
  // (c) doc incorreto precede evidência: heurística definitiva rejeita sozinha.
  if (heuristic.status === 'not-covered') {
    if (execRequired) {
      return failNotCovered(
        `${heuristic.reason} — fix the docs content (correction) and re-review${opts?.executedEvidence ? ' (executed evidence does not rescue incorrect docs)' : ''}`,
      );
    }
    return heuristic;
  }
  // Heuristic internal contradiction needs a human — semantic alone cannot settle it.
  if (heuristic.status === 'inconclusive' && /contradict/i.test(heuristic.reason)) {
    return failInconclusive(
      `${heuristic.reason} — semantic review cannot override an internal contradiction alone`,
    );
  }
  // Execution criteria (k2/req-4): prose alone never proves a run. Valid
  // product-executed evidence is required; docs correctness still required.
  if (execRequired) {
    const check = validateDocsExecutedEvidence(opts?.executedEvidence, opts?.jobHead ?? '');
    if (!check.ok) return failNotCovered(check.reason);
    if (heuristic.status !== 'covered') {
      return failNotCovered(
        `${heuristic.reason} — fix the docs content (correction) and re-review (executed evidence valid but docs substance still required)`,
      );
    }
  }
  if (!semantic || typeof semantic !== 'object') {
    return failInconclusive(
      `heuristic is ${heuristic.status} but no semantic review was provided (heuristic alone never verifies semantic judgment)`,
    );
  }
  const verdict = (semantic as { verdict?: unknown }).verdict;
  const reasonRaw = (semantic as { reason?: unknown }).reason;
  const evidenceRaw = (semantic as { evidence?: unknown }).evidence;
  if (verdict !== 'pass' && verdict !== 'fail' && verdict !== 'inconclusive') {
    return failInconclusive('semantic review is malformed (unknown verdict)');
  }
  const reason = typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw.trim().slice(0, 500) : '';
  if (!reason) return failInconclusive('semantic review carries no reason');
  const evidence = Array.isArray(evidenceRaw)
    ? evidenceRaw.map(String).map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 8)
    : [];
  if (verdict === 'fail') {
    if (execRequired && EXEC_OUTPUT_LACK_RE.test(reason)) {
      const ev = opts?.executedEvidence!;
      return {
        covered: true,
        status: 'covered',
        reason: `requirement "${requirement.id}" verified by docs + executed evidence: product-executed "${ev.command}" exit 0 at ${ev.testedCommit.slice(0, 8)} with observable output — execution proof supplied by evidence, docs correctly document the command (semantic output-in-docs complaint set aside: ${reason} — evidence: ${evidence.slice(0, 2).join(' | ') || '(cited passages in review)'})`,
      };
    }
    if (execRequired) {
      return failNotCovered(
        `semantic review rejects: ${reason} — evidence: ${evidence.slice(0, 2).join(' | ') || '(cited passages in review)'} — fix the docs content (correction) and re-review`,
      );
    }
    return failNotCovered(`semantic review rejects: ${reason} — evidence: ${evidence.slice(0, 2).join(' | ') || '(cited passages in review)'}`);
  }
  if (verdict === 'inconclusive') {
    return failInconclusive(`semantic review is inconclusive: ${reason}`);
  }
  // verdict === 'pass': fail-closed downgrades (never verified on doubt).
  const demonstrated = (semantic as { demonstrated?: unknown }).demonstrated;
  if (demonstrated !== undefined && demonstrated !== true) {
    return failInconclusive(`semantic pass without demonstrated=true (${reason})`);
  }
  if (evidence.length === 0) {
    return failInconclusive(`semantic pass without doc evidence (${reason}) — citations required, never verified on assertion alone`);
  }
  if (VERIFIED_UNCERTAINTY_RE.test(reason)) {
    return failInconclusive(`semantic pass expresses uncertainty (${reason})`);
  }
  if (VERIFIED_CONTRADICTS_PASS_RE.test(reason)) {
    return failInconclusive(`semantic pass contradicts its own reason (${reason})`);
  }
  return {
    covered: true,
    status: 'covered',
    reason: `requirement "${requirement.id}" verified by docs + semantic review: ${reason} — evidence: ${evidence.slice(0, 2).join(' | ')}`,
  };
}
