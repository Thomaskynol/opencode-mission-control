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
  return text
    .split(/[.!?\n;]+/)
    .map((s) => s.trim().replace(/^#+\s*/, ''))
    .filter((s) => s.length > 0);
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

function sentenceHasInstruction(sentence: string, kwLower: string[], litLower: string[]): boolean {
  return PROCEDURAL_VERB_RE.test(sentence) && extrasOf(sentence, kwLower, litLower).size >= 2;
}

/**
 * Affirmative explanatory substance: only an instructive sentence counts (procedural verb + new informative words).
 * Descriptive-only prose without instruction is inconclusive fail-closed (human/external decides, never auto-pass).
 */
function hasAffirmativeSubstance(combined: string, keywords: string[], literals: string[]): boolean {
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
    if (sentenceHasInstruction(s, kwLower, litLower)) return true;
  }
  return false;
}

/**
 * Judge one acceptance requirement against examined docs content.
 * Fail-closed: no content, trivial content, explicit denial/disclaimer,
 * missing literals/keywords, broken links, or missing explanatory substance
 * all reject. Literals/titles/links/keywords are auxiliary evidence only —
 * coverage requires affirmative explanatory substance about the criterion.
 * When substance is absent without explicit denial, the result is
 * `inconclusive` (uncertainty, fail-closed: external reviewer or explicit
 * human accept required, never auto-pass).
 */
export function assessDocsCoverage(
  requirement: DocsRequirement,
  docsContents: Record<string, string>,
  opts?: { existingPaths?: string[] | Set<string> },
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
      if (!sentenceHasInstruction(raw, kwLower, litLower)) {
        return failNotCovered(
          `docs deny coverage ("${raw.slice(0, 140)}") — content contradicts the criterion, fix the docs or accept explicitly`,
        );
      }
    }
  }
  // Required literals (commands, file names, numbers, quoted spans) must appear verbatim.
  // Auxiliary only: presence never proves coverage, absence rejects.
  for (const lit of literals) {
    if (!lowered.includes(lit.toLowerCase())) {
      return failNotCovered(`required literal "${lit}" not found in the examined docs — document it verbatim`);
    }
  }
  // Keyword majority: the prose must be about the requirement, not another topic.
  // Auxiliary only: mention without explanation never passes (see substance below).
  if (keywords.length > 0) {
    const hits = keywords.filter((k) => lowered.includes(k));
    const need = Math.max(1, Math.ceil(keywords.length / 2));
    if (hits.length < need) {
      return failNotCovered(
        `docs mention ${hits.length}/${keywords.length} required topic(s) (need ${need}: ${keywords.join('/')}) — the content is about something else`,
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
  // Substance gate: mention is not explanation. Without an affirmative
  // instructional/explanatory sentence about the topic, coverage cannot be
  // established — return the dedicated inconclusive state (fail-closed).
  if (!hasAffirmativeSubstance(combined, keywords, literals)) {
    return failInconclusive(
      `docs mention the topic but provide no affirmative explanatory substance (no instructive sentence with new informative content — only repetition, titles, or disclaimed text found)`,
    );
  }
  const covered: DocsAssessment = {
    covered: true,
    status: 'covered',
    reason: `requirement "${requirement.id}" covered by docs: ${paths.join(', ')}`,
  };
  return covered;
}
