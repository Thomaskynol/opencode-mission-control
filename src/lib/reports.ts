import { join } from 'path';
import { getDataDir } from './paths';
import { SERVE_PLUGIN_RUNTIME_LIMITATION } from './worktree-setup';

export type ReportStatus = 'working' | 'blocked' | 'needs_review' | 'completed' | 'progress' | 'paused';

export interface AgentReport {
  jobId: string;
  jobName: string;
  status: ReportStatus;
  message: string;
  progress?: number;
  timestamp: string;
}

async function getReportsDir(): Promise<string> {
  const dataDir = await getDataDir();
  const reportsDir = join(dataDir, '..', 'reports');
  const fs = await import('fs');
  fs.mkdirSync(reportsDir, { recursive: true });
  return reportsDir;
}

function getReportFilePath(reportsDir: string, jobId: string): string {
  return join(reportsDir, `${jobId}.json`);
}

export async function writeReport(report: AgentReport): Promise<void> {
  const reportsDir = await getReportsDir();
  const filePath = getReportFilePath(reportsDir, report.jobId);
  const tempPath = `${filePath}.tmp`;
  const data = JSON.stringify(report, null, 2);
  await Bun.write(tempPath, data);
  const fs = await import('fs');
  fs.renameSync(tempPath, filePath);
}

export async function readReport(jobId: string): Promise<AgentReport | null> {
  const reportsDir = await getReportsDir();
  const filePath = getReportFilePath(reportsDir, jobId);
  const file = Bun.file(filePath);
  const exists = await file.exists();

  if (!exists) {
    return null;
  }

  try {
    const content = await file.text();
    return JSON.parse(content) as AgentReport;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error; // IO/read errors propagate — only malformed JSON is "corrupt"
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[MC] Skipping corrupt report ${filePath} (job: ${jobId}): ${reason}`);
    return null;
  }
}

export async function readAllReports(): Promise<AgentReport[]> {
  const reportsDir = await getReportsDir();
  const fs = await import('fs');

  let entries: string[];
  try {
    entries = fs.readdirSync(reportsDir);
  } catch {
    return [];
  }

  const reports: AgentReport[] = [];
  let skipped = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.endsWith('.tmp')) {
      continue;
    }

    const filePath = join(reportsDir, entry);
    try {
      const file = Bun.file(filePath);
      const content = await file.text();
      const report = JSON.parse(content) as AgentReport;
      reports.push(report);
    } catch (error) {
      // Bulk listing stays resilient: corrupt JSON and IO failures both skip, with distinct warns (single readReport propagates IO)
      skipped += 1;
      const jobId = entry.slice(0, -'.json'.length);
      const reason = error instanceof Error ? error.message : String(error);
      const kind = error instanceof SyntaxError ? 'corrupt' : 'unreadable (IO)';
      console.warn(
        `[MC] Skipping ${kind} report ${filePath} (job: ${jobId}): ${reason}`,
      );
    }
  }

  if (skipped > 0) {
    console.warn(`[MC] Skipped ${skipped} corrupt report(s) in ${reportsDir}`);
  }

  return reports;
}

export async function removeReport(jobId: string): Promise<void> {
  const reportsDir = await getReportsDir();
  const filePath = getReportFilePath(reportsDir, jobId);
  const fs = await import('fs');

  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return; // File doesn't exist, nothing to remove
    }
    throw error;
  }
}

/**
 * OMO status line for the final report. Without OMO the report declares
 * the limitation explicitly (vanilla execution only) — never a silent
 * success. With OMO it records the parity path (serve /command, no TUI
 * keystrokes). The launch path already reads detectOMO (non-vanilla
 * without OMO fails closed there, before any session exists); this
 * helper is how that outcome is registered in the report.
 */
export function describeOmoLimitation(detected: boolean, mode?: string): string {
  const scope = mode && mode !== 'vanilla' ? ` (mode "${mode}")` : '';
  if (detected) {
    return `OMO detected${scope} — slash-command parity via serve /command, no TUI keystrokes.`;
  }
  return `Limitation: OMO not detected${scope} — OMO paths unavailable; vanilla execution only, no silent OMO fallback.`;
}

/**
 * M6: rotulagem canônica de ator para decisões/log/report.
 * - human: auto-declaração sem atestação fora de banda (nunca fato).
 *   A flag --actor human não comprova humano; origem não comprovada salvo
 *   conferência externa explícita (humano necessário nunca simulado).
 * - agent-operator / system: não-humanos.
 * - ausente/qualquer outro: desconhecido (nunca atribuir ação a pessoa sem evidência).
 */
export function formatActorLabel(actor?: string): string {
  if (actor === 'human') {
    return 'ator human (auto-declarado, sem atestação fora de banda — não verificado, origem não comprovada; --actor human não comprova humano)';
  }
  if (actor === 'agent-operator') {
    return 'ator agent-operator (não-humano)';
  }
  if (actor === 'system') {
    return 'ator system (automação do produto, não-humano)';
  }
  return 'ator desconhecido (desconhecido, origem não comprovada)';
}

/**
 * R2: fonte da alegação de ator a partir do texto do registro.
 * - flag CLI (`--actor X`) → fonte flag CLI.
 * - sessão interativa / conferência externa explícitas → respectivas fontes.
 * - indistinguível (caso comum: rótulo "ator human" sem flag nem
 *   conferência) → "origem não comprovada" (nunca presumir humano).
 */
export function describeActorSource(text: string): string {
  if (/--actor\s*[= ]\s*(human|agent-operator|system)\b/i.test(text)) {
    return 'fonte: flag CLI (--actor)';
  }
  if (/sessão interativa/i.test(text)) {
    return 'fonte: sessão interativa';
  }
  if (/conferência externa|atestação externa|verificado externamente/i.test(text)) {
    return 'fonte: conferência externa';
  }
  return 'origem não comprovada';
}

/**
 * M6: extrai o ator mencionado numa linha de decisão/log (`ator human|...`
 * ou `--actor X`). Retorna undefined quando não há evidência de ator —
 * o chamador deve então registrar desconhecido, nunca presumir.
 */
export function extractActorMention(text: string): 'human' | 'agent-operator' | 'system' | undefined {
  const labeled = text.match(/ator\s+(human|agent-operator|system)\b/i);
  if (labeled) return labeled[1]!.toLowerCase() as 'human' | 'agent-operator' | 'system';
  const flag = text.match(/--actor\s*[= ]\s*(human|agent-operator|system)\b/i);
  if (flag) return flag[1]!.toLowerCase() as 'human' | 'agent-operator' | 'system';
  return undefined;
}

/** Max length for one-line report summaries shown in the human TUI. */
export const REPORT_LINE_MAX = 140;

function truncateLine(text: string, maxLength: number = REPORT_LINE_MAX): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

/**
 * Jobs merged into the integration branch with no per-instance mc_report
 * contribution. A merge is integration, not authorship: without the
 * worker report the final document must name the gap explicitly instead
 * of printing a clean Verified section next to a placeholder.
 */
function missingContributionJobs(input: FinalReportInput): string[] {
  const merged = input.integration?.merged ?? [];
  if (merged.length === 0) return [];
  const have = new Set((input.contributions ?? []).map((c) => c.job));
  return merged.filter((name) => !have.has(name));
}

/**
 * Short one-liner for a report (milestones, alerts, TUI rows).
 * The percentage suffix appears ONLY when the worker explicitly sent
 * `progress` — never invented here.
 */
export function formatReportLine(report: AgentReport): string {
  const suffix =
    report.progress !== undefined ? ` (${report.progress}%)` : '';
  return truncateLine(`• ${report.jobName} [${report.status}]: ${report.message}${suffix}`);
}

export interface MilestoneOptions {
  /** Explicit completion percentage from the worker. Omit when unknown. */
  progress?: number;
  status?: ReportStatus;
}

/**
 * Short milestone report. `progress` is recorded only when the caller
 * passes it explicitly — the coordinator never fabricates percentages.
 */
export async function writeMilestoneReport(
  jobId: string,
  jobName: string,
  message: string,
  opts: MilestoneOptions = {},
): Promise<void> {
  if (
    opts.progress !== undefined &&
    (!Number.isFinite(opts.progress) || opts.progress < 0 || opts.progress > 100)
  ) {
    throw new Error(`Invalid progress ${opts.progress}: expected 0-100 or omitted.`);
  }
  await writeReport({
    jobId,
    jobName,
    status: opts.status ?? (opts.progress !== undefined ? 'progress' : 'working'),
    message,
    ...(opts.progress !== undefined ? { progress: opts.progress } : {}),
    timestamp: new Date().toISOString(),
  });
}

/**
 * Immediate blockade/failure notice. Surfaces in the overview Alerts
 * section and the human TUI; independent fronts keep running.
 */
export async function writeAlertReport(
  jobId: string,
  jobName: string,
  message: string,
): Promise<void> {
  await writeReport({
    jobId,
    jobName,
    status: 'blocked',
    message,
    timestamp: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// M5/M7: standardized final report (readable body + annexes/references).
// The body separates verified facts from gaps (unmet/unverified); long logs
// always go to annexes, never inline.
// ---------------------------------------------------------------------------

export interface FinalReportTask {
  name: string;
  status: string;
  detail?: string;
}

export interface FinalReportContribution {
  instance: string;
  job: string;
  summary: string;
}

export interface FinalReportTest {
  command: string;
  result: string;
  output?: string;
}

export interface FinalReportProblem {
  problem: string;
  solution: string;
  /**
   * Lane F: estado do problema a partir de registros reais.
   * - resolvido: evidência posterior de pass/merged.
   * - pendente: aceite com ressalva, retry/deadlock sem pass, gap aberto.
   * - desconhecido: sem evidência para classificar (lacuna, nunca sucesso).
   */
  status?: 'resolvido' | 'pendente' | 'desconhecido';
}

/**
 * Execution environment: USED vs DETECTED (Achado 4 M4). Each line records
 * what the run effectively used (per-job mode, server-observed model pin,
 * agent when set) and what was merely detected in config (OMO presence,
 * default mode) — detection is never presented as use.
 */
export type FinalReportEnvironmentLine = string;

export interface FinalReportAttachment {
  name: string;
  content: string;
}

export interface FinalReportPreservation {
  preserved?: string[];
  closed?: string[];
  cleanup?: string[];
}

export interface FinalReportInput {
  title: string;
  request?: string;
  scope?: string[];
  architecture?: string[];
  decisions?: string[];
  tasks?: FinalReportTask[];
  contributions?: FinalReportContribution[];
  files?: string[];
  branches?: string[];
  integration?: {
    branch?: string;
    strategy?: string;
    merged?: string[];
    conflicts?: string[];
    note?: string;
  };
  installUsage?: string[];
  tests?: FinalReportTest[];
  evidences?: string[];
  problems?: FinalReportProblem[];
  verified?: string[];
  unmet?: string[];
  unverified?: string[];
  /**
   * Merged jobs cujo report por instância está ausente E cujo plugin serve
   * nunca teve a carga confirmada (sem ACK do runtime). As linhas de gap
   * missing desses jobs levam a ressalva sem-ACK explícita — nunca
   * "garantido". Opcional: ausente = comportamento anterior (gap puro).
   */
  pluginNoAckJobs?: string[];
  environment?: FinalReportEnvironmentLine[];
  limitations?: string[];
  nextSteps?: string[];
  preservation?: FinalReportPreservation;
  attachments?: FinalReportAttachment[];
}

/** Annex cap: long logs are truncated with an explicit marker, never dropped silently. */
export const FINAL_REPORT_ATTACHMENT_MAX = 12000;

/**
 * Lane F: deriva Problems de REGISTROS REAIS (decisions, unmet, unverified,
 * contributions ausentes). Distingue resolvido / pendente / desconhecido;
 * sem inventar dados (lacuna = "desconhecido", não sucesso). Aceite explícito
 * é sempre pendente com ressalva — nunca resolvido, nunca verified.
 */
export function deriveProblemsFromRecords(input: FinalReportInput): FinalReportProblem[] {
  const out: FinalReportProblem[] = [];
  const decisions = input.decisions ?? [];
  const joined = decisions.join('\n');
  const hasNonAcceptPass = decisions.some(
    (d) => /:\s*pass\b/i.test(d) && !/accept honored/i.test(d),
  );
  // Sem evidência para classificar causa (records removidos): lacuna explícita.
  if (decisions.length === 0 && ((input.unmet ?? []).length > 0 || (input.unverified ?? []).length > 0)) {
    out.push({
      problem: 'causa sem evidência registrada (decisions vazias) — registros removidos ou nunca persistidos',
      solution: 're-executar com decisions/logs preservados para classificar; não assumir sucesso',
      status: 'desconhecido',
    });
  }
  // Outage transitória do provedor (evidência real: provider.no-route / Model unavailable).
  if (/provider\.no-route|Model unavailable|outage/i.test(joined)) {
    out.push({
      problem: 'outage transitória do provedor (provider.no-route / Model unavailable) — revisor externo indisponível, fail-closed',
      solution: 'fail-closed + retentativa via retry/resume; superada quando revisão passa sem outage',
      status: hasNonAcceptPass ? 'resolvido' : 'pendente',
    });
  }
  // Deadlock / retry / fail-closed (evidência real: vereditos alternados, auto-fix, fail).
  if (/deadlock|req-3.*req-4|vereditos alternados|auto-fix attempt|review .*: fail/i.test(joined)) {
    const excerpt = decisions.find((d) => /deadlock|req-3|auto-fix attempt|review .*: fail/i.test(d));
    out.push({
      problem: `deadlock/retry do gate funcional (fail → correção → fail)${excerpt ? `: ${excerpt.slice(0, 220)}` : ''}`,
      solution: 'correção via retry/relaunch com re-revisão; aceite só com ressalva quando pins travam',
      status: hasNonAcceptPass ? 'resolvido' : 'pendente',
    });
  }
  // Aceites explícitos (evidência real: approve accept / operator accept honored).
  // R2: todo aceite renderiza ator + fonte + COM RESSALVA (nunca Verified).
  // Sem menção de ator nos registros = desconhecido com origem não
  // comprovada (nunca presumir humano); --actor human nunca comprova humano.
  const acceptDecs = decisions.filter((d) => /approve accept|operator accept honored/i.test(d));
  for (const dec of acceptDecs) {
    const mentioned = extractActorMention(dec);
    const hasLabel = /ator\s+(human|agent-operator|system)\b|auto-declarado|não-humano|desconhecido/i.test(dec);
    const actorPart = mentioned
      ? (hasLabel ? '' : ` — por ${formatActorLabel(mentioned)}`)
      : ` — por ator desconhecido (desconhecido, origem não comprovada)`;
    out.push({
      problem: `aceite explícito com ressalva: ${dec.slice(0, 240)}${actorPart} (${describeActorSource(dec)}) — prossegue COM RESSALVA, sem selo verified (aceite nunca Verified; --actor human não comprova humano)`,
      solution: 'permanece Unverified (cobertura só por smoke global); resolver pendência e re-verificar por critério',
      status: 'pendente',
    });
  }
  // Conductor takeover / intervenção do operador (evidência real de handoff).
  // M6: cada decisão exibe o ator (human auto-declarado COM RESSALVA vs
  // agent-operator vs system); sem evidência de ator, desconhecido.
  // R2: fonte da alegação sempre explícita (flag CLI vs origem não comprovada);
  // identidade declarada sem confirmação nunca lê-se como humano confirmado.
  if (/conductor takeover|approve --takeover|approve\/retry|approve\/relaunch|approve --retry|approve --relaunch|approve\/clear|approve\/start|approve --start|resume --intake|resume: conductor|touchset:/i.test(joined)) {
    const excerpt = decisions.find((d) => /conductor takeover|approve --takeover|approve\/retry|approve\/relaunch|approve --retry|approve --relaunch|approve\/clear|approve\/start|approve --start|resume --intake|resume: conductor|touchset:/i.test(d));
    const mentioned = excerpt ? extractActorMention(excerpt) : undefined;
    const actorSuffix = mentioned
      ? ` — por ${formatActorLabel(mentioned)}`
      : ' — ator desconhecido (desconhecido, origem não comprovada)';
    const sourceSuffix = ` (${describeActorSource(excerpt ?? '')})`;
    out.push({
      problem: `intervenção do operador via caminho público${excerpt ? `: ${excerpt.slice(0, 220)}` : ''}${actorSuffix}${sourceSuffix}`,
      solution: 'handoff auditado (epoch/pid) + re-validação do produto; sem extrapolar posse',
      status: hasNonAcceptPass ? 'resolvido' : 'pendente',
    });
  }
  // Pendências aceitas cobertas só por smoke global (unverified integration-only).
  for (const entry of input.unverified ?? []) {
    if (/covered only by global integration/i.test(entry)) {
      out.push({
        problem: `pendência aceita sem verificação task-scoped: ${entry.slice(0, 240)} — COM RESSALVA`,
        solution: 'não promove a Verified; re-verificar por critério task-scoped',
        status: 'pendente',
      });
    }
  }
  // Reports por instância ausentes (merged sem mc_report).
  for (const name of missingContributionJobs(input)) {
    if (!out.some((p) => p.problem.includes(`"${name}"`))) {
      out.push({
        problem: `merged sem mc_report por instância: "${name}" (autoria não comprovada)`,
        solution: 'cobrar mc_report do worker ou registrar lacuna; merge é integração, não verificação',
        status: 'pendente',
      });
    }
  }
  // cav-2.2: fallback por gap — rewording futuro de decisions não pode
  // silenciar Problems. Para cada unmet/unverified sem cobertura em nenhum
  // problema derivado (ou já passado em input.problems), emite desconhecido
  // por entrada. Cobertura = contenção do trecho do gap (60 chars), não só
  // job-name — pendência distinta exige entrada distinta.
  const gaps = [...(input.unmet ?? []), ...(input.unverified ?? [])];
  const existing = [...out, ...((input.problems ?? []) as FinalReportProblem[])];
  for (const gap of gaps) {
    const probe = gap.slice(0, 60);
    const covered = existing.some(
      (p) => p.problem.includes(probe) || gap.includes(p.problem.slice(0, 60)),
    );
    if (!covered) {
      out.push({
        problem: `pendência sem classificação: ${gap.slice(0, 240)} — causa não reconhecida nos registros, não assumir sucesso`,
        solution: 'preservar decisions/logs e classificar a causa; re-verificar por critério antes de promover',
        status: 'desconhecido',
      });
    }
  }
  return out;
}

/**
 * M8: categorias de gaps para o header clicar com a seção Gaps.
 * Conta por marcadores canônicos (mesmos textos emitidos por
 * mc_report_final): aceites com ressalva, cobertura parcial (smoke global),
 * sem mc_report, sem evidência task-scoped, comando trivial, pendências
 * humanas; o resto conta como outro(s). Aceite nunca sai daqui para
 * Verified — ver excludeAcceptedFromVerified.
 */
export function describeGapCategories(items: string[]): string {
  const count = (re: RegExp) => items.filter((entry) => re.test(entry)).length;
  const parts: string[] = [];
  const aceites = count(/aceite/);
  if (aceites > 0) parts.push(`${aceites} aceite(s) com ressalva`);
  const parcial = count(/covered only by global integration smoke/);
  if (parcial > 0) parts.push(`${parcial} cobertura parcial (smoke global)`);
  const semContrib = count(/missing per-instance report/);
  if (semContrib > 0) parts.push(`${semContrib} sem mc_report`);
  const semEvid = count(/sem evid[êe]ncia task-scoped/);
  if (semEvid > 0) parts.push(`${semEvid} sem evidência task-scoped`);
  const trivial = count(/comando de teste trivial/);
  if (trivial > 0) parts.push(`${trivial} comando trivial`);
  const pending = count(/pending human decision|permission escalation pendente/);
  if (pending > 0) parts.push(`${pending} pendência(s) humana(s)`);
  const outros = items.length - aceites - parcial - semContrib - semEvid - trivial - pending;
  if (outros > 0) parts.push(`${outros} outro(s)`);
  return parts.join(' + ');
}

/**
 * R2: aceite nunca Verified — linha de gap canônica para jobs com
 * reviewApproval integrados. Renderiza ator + COM RESSALVA em Gaps, mesmo
 * quando a evidência task-scoped existir (retry operacional, sem approval,
 * pode verificar; accept, com approval, nunca).
 */
export function formatAcceptGap(jobName: string, actor?: string): string {
  return `${jobName} [merged, aceite ${formatActorLabel(actor)}] — COM RESSALVA (permanece Unverified, sem selo verified; aceite nunca Verified)`;
}

/**
 * R2: nomes de jobs aceitos a partir das decisões (`approve accept: "N"`
 * ou `accept "N"`). Usado para excluir aceites de Verified mesmo quando o
 * chamador só tem decisions (sem acesso ao plan).
 */
export function acceptedJobNamesFromDecisions(decisions: string[]): string[] {
  const out = new Set<string>();
  for (const d of decisions) {
    const m1 = d.match(/approve accept:\s*"([^"]+)"/i);
    if (m1?.[1]) out.add(m1[1]);
    const m2 = d.match(/\baccept\s+"([^"]+)"/i);
    if (m2?.[1] && /approve accept|operator accept/i.test(d)) out.add(m2[1]);
    const m3 = d.match(/review\s+(\S+?):\s*pass\s*\(operator accept honored/i);
    if (m3?.[1]) out.add(m3[1]);
  }
  return [...out];
}

/**
 * R2: exclui aceites de uma lista Verified já montada (fail-closed).
 * Entradas Verified têm forma `${job} [...]`; qualquer entrada cujo job
 * conste em `accepted` é removida (aceite nunca Verified, em nenhum escopo).
 */
export function excludeAcceptedFromVerified(verified: string[], accepted: string[]): string[] {
  if (accepted.length === 0) return verified;
  const set = new Set(accepted);
  return verified.filter((entry) => {
    for (const name of set) {
      if (entry === name || entry.startsWith(`${name} `) || entry.startsWith(`${name} [`)) return false;
    }
    return true;
  });
}

function formatProblemEntry(entry: FinalReportProblem): string {
  const status = entry.status ?? 'desconhecido';
  return `- Problem: ${entry.problem} | Solution: ${entry.solution} | Status: ${status}`;
}

function finalReportLines(items: string[] | undefined, emptyNote: string): string[] {
  if (!items || items.length === 0) {
    return [`- ${emptyNote}`];
  }
  return items.map((item) => `- ${item}`);
}

/**
 * Gap canônico para merged sem mc_report por instância. Com
 * `pluginNoAck`, o job é serve-mode sem report válido (ausente ou
 * inválido, ambos sem evidência de worker-declarado): a linha leva a
 * ressalva sem-ACK — o plugin foi preparado mas a carga nunca foi
 * confirmada pelo runtime. Mantém o prefixo canônico para as categorias
 * (`describeGapCategories` conta "sem mc_report" do mesmo jeito).
 */
export function formatMissingReportGap(jobName: string, opts?: { pluginNoAck?: boolean }): string {
  const base = `missing per-instance report for "${jobName}" (merged without mc_report)`;
  return opts?.pluginNoAck ? `${base}; ${SERVE_PLUGIN_RUNTIME_LIMITATION}` : base;
}

/**
 * Pure builder for the standardized final report. Every required section is
 * always emitted (with an explicit placeholder when empty) so readers can
 * tell "not reported" apart from "reported empty". Verified facts and gaps
 * live in separate sections by construction.
 */
export function buildFinalReportMarkdown(input: FinalReportInput): string {
  // Merged jobs with no mc_report contribution: named explicitly here and
  // under Gaps — never a clean Verified section next to a placeholder.
  const missingReports = missingContributionJobs(input);
  const noAckSet = new Set(input.pluginNoAckJobs ?? []);
  const missingGapEntries = missingReports
    .filter((name) => !(input.unverified ?? []).some((entry) => entry.includes(name)))
    .map((name) => formatMissingReportGap(name, { pluginNoAck: noAckSet.has(name) }));
  const lines: string[] = [
    `# Final Report: ${input.title}`,
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Request & Scope',
    '',
    input.request?.trim() ? input.request.trim() : '- Not reported',
    '',
    ...finalReportLines(input.scope, 'No scope items reported'),
    '',
    '## Architecture & Decisions',
    '',
    ...finalReportLines(input.architecture, 'No architecture notes reported'),
    '',
    ...finalReportLines(
      (input.decisions ?? []).map((decision) => `Decision: ${decision}`),
      'No decisions recorded',
    ),
    '',
    '## Plan & Tasks',
    '',
    ...((input.tasks ?? []).length > 0
      ? input.tasks!.map((task) =>
        task.detail?.trim()
          ? `- [${task.status}] ${task.name} — ${task.detail.trim()}`
          : `- [${task.status}] ${task.name}`,
      )
      : ['- No tasks reported']),
    '',
    '## Per-Instance Contributions',
    '',
    ...(() => {
      const listed = (input.contributions ?? []).map((c) => `- ${c.instance} / ${c.job}: ${c.summary}`);
      const gaps = missingReports.map(
        (name) => `- Missing per-instance report for merged job "${name}" (no mc_report received — see Gaps)`,
      );
      if (listed.length === 0 && gaps.length === 0) return ['- No per-instance contributions reported'];
      return [...listed, ...gaps];
    })(),
    '',
    '## Files & Branches',
    '',
    ...finalReportLines(
      (input.files ?? []).map((file) => `File: ${file}`),
      'No files reported',
    ),
    '',
    ...finalReportLines(
      (input.branches ?? []).map((branch) => `Branch: ${branch}`),
      'No branches reported',
    ),
    '',
    '## Integration',
    '',
    `- Branch: ${input.integration?.branch?.trim() || 'Not reported'}`,
    `- Strategy: ${input.integration?.strategy?.trim() || 'Not reported'}`,
    ...finalReportLines(
      (input.integration?.merged ?? []).map((name) => `Merged: ${name}`),
      'No merges reported',
    ),
    ...finalReportLines(
      (input.integration?.conflicts ?? []).map((name) => `Conflict: ${name}`),
      'No conflicts reported',
    ),
  ];
  if (input.integration?.note?.trim()) {
    lines.push('', `- Note: ${input.integration.note.trim()}`);
  }
  lines.push(
    '',
    '## Install & Usage',
    '',
    ...finalReportLines(input.installUsage, 'No install/usage notes reported'),
    '',
    '## Tests (Commands & Results)',
    '',
    ...((input.tests ?? []).length > 0
      ? input.tests!.flatMap((test) => {
        const header = `- \`${test.command}\` → ${test.result}`;
        if (!test.output?.trim()) return [header];
        const snippet = test.output.trim().slice(0, 500);
        return [header, `  Output: ${snippet}`];
      })
      : ['- No tests reported']),
    '',
    '## Real Evidence',
    '',
    ...finalReportLines(input.evidences, 'No real evidence attached yet'),
    '',
    '## Problems & Solutions',
    '',
    ...(() => {
      const derived = deriveProblemsFromRecords(input);
      const seen = new Set<string>();
      const merged: FinalReportProblem[] = [];
      for (const entry of [...(input.problems ?? []), ...derived]) {
        const key = entry.problem.slice(0, 160);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(entry);
      }
      if (merged.length === 0) {
        const hasGaps = ((input.unmet ?? []).length > 0) || ((input.unverified ?? []).length > 0) || missingGapEntries.length > 0;
        // shortcut: sem evidência e sem gaps = nada a declarar; com gaps = desconhecido (nunca sucesso).
        if (!hasGaps) return ['- No problems reported'];
        return ['- Unknown: sem evidência de problemas registrada (desconhecido — não verificado como sucesso) | Status: desconhecido'];
      }
      return merged.map(formatProblemEntry);
    })(),
    '',
    '## Verified',
    '',
    ...finalReportLines(input.verified, 'Nothing verified yet'),
    '',
    '## Gaps (Unmet / Unverified)',
    '',
    ...(() => {
      const unmetItems = input.unmet ?? [];
      const allUnverified = [...(input.unverified ?? []), ...missingGapEntries];
      const unverifiedCount = allUnverified.length;
      const cats = unverifiedCount > 0 ? describeGapCategories(allUnverified) : '';
      // M6: "No unmet items" convivendo com Unverified induz otimismo —
      // ausência de Unmet nunca é sucesso quando há Unverified. M8: o total
      // inclui sem-mc_report (categorias abaixo = mesmo total do header).
      if (unmetItems.length === 0 && unverifiedCount > 0) {
        return [`- No unmet items reported (atenção: há ${unverifiedCount} item(ns) Unverified abaixo — ausência de Unmet não é sucesso; categorias: ${cats})`];
      }
      return finalReportLines(
        unmetItems.map((item) => `Unmet: ${item}`),
        'No unmet items reported',
      );
    })(),
    '',
    ...finalReportLines(
      [...(input.unverified ?? []), ...missingGapEntries].map((item) => `Unverified: ${item}`),
      'No unverified items reported',
    ),
    ...(() => {
      const allUnverified = [...(input.unverified ?? []), ...missingGapEntries];
      if (allUnverified.length === 0) return [];
      // M8: total explícito para clicar com o header (Unverified: N (...)).
      return [`- Total Unverified: ${allUnverified.length} (${describeGapCategories(allUnverified)}) — mesmo total do header`];
    })(),
    '',
    '## Environment (Used vs Detected)',
    '',
    ...finalReportLines(input.environment, 'No environment info reported'),
    '',
    '## Limitations & Next Steps',
    '',
    ...finalReportLines(
      (input.limitations ?? []).map((item) => `Limitation: ${item}`),
      'No limitations reported',
    ),
    '',
    ...finalReportLines(
      (input.nextSteps ?? []).map((item) => `Next: ${item}`),
      'No next steps reported',
    ),
    '',
    '## Preservation (Preserved vs Closed vs Cleanup)',
    '',
    ...finalReportLines(
      (input.preservation?.preserved ?? []).map((item) => `Preserved (work kept): ${item}`),
      'Nothing flagged as preserved',
    ),
    '',
    ...finalReportLines(
      (input.preservation?.closed ?? []).map((item) => `Closed (finished): ${item}`),
      'Nothing flagged as closed',
    ),
    '',
    ...finalReportLines(
      (input.preservation?.cleanup ?? []).map((item) => `Cleanup (explicit removal only): ${item}`),
      'Nothing flagged for cleanup',
    ),
    '',
    '## Annexes (Logs & References)',
    '',
    ...((input.attachments ?? []).length > 0
      ? input.attachments!.flatMap((attachment, index) => {
        const content = attachment.content ?? '';
        const truncated = content.length > FINAL_REPORT_ATTACHMENT_MAX;
        const body = truncated
          ? `${content.slice(0, FINAL_REPORT_ATTACHMENT_MAX)}\n…[truncated ${content.length - FINAL_REPORT_ATTACHMENT_MAX} chars, see source]`
          : content;
        return [
          `### Annex ${String.fromCharCode(65 + index)}: ${attachment.name}`,
          '',
          '```',
          body || '(empty)',
          '```',
          '',
        ];
      })
      : ['- No annexes (long logs belong here, never inline above)']),
  );
  return lines.join('\n');
}

function getFinalReportFilePath(reportsDir: string, planId: string): string {
  return join(reportsDir, `final-${planId}.md`);
}

/** Persist a rendered final report next to the per-job reports. */
export async function writeFinalReport(planId: string, markdown: string): Promise<string> {
  const reportsDir = await getReportsDir();
  const filePath = getFinalReportFilePath(reportsDir, planId);
  await Bun.write(filePath, markdown);
  return filePath;
}

/** Read a persisted final report, if any. */
export async function readFinalReport(planId: string): Promise<string | null> {
  const reportsDir = await getReportsDir();
  const file = Bun.file(getFinalReportFilePath(reportsDir, planId));
  if (!(await file.exists())) {
    return null;
  }
  return file.text();
}
