import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { isInManagedWorktree } from '../lib/worktree';
import { getJobByName, loadJobState } from '../lib/job-state';
import { loadPlan } from '../lib/plan-state';
import {
  readAllReports,
  buildFinalReportMarkdown,
  writeFinalReport,
  describeOmoLimitation,
  deriveProblemsFromRecords,
  describeGapCategories,
  formatActorLabel,
  formatAcceptGap,
  excludeAcceptedFromVerified,
  type ReportStatus,
} from '../lib/reports';
import { writeReport } from '../lib/reports';
import { detectOMO } from '../lib/omo';

export const mc_report: ToolDefinition = tool({
  description:
    'Report agent status back to Mission Control. Auto-detects which job is calling based on the current worktree.',
  args: {
    status: tool.schema
      .enum(['working', 'blocked', 'needs_review', 'completed', 'progress'])
      .describe(
        'Current status: working (actively coding), blocked (waiting/stuck), needs_review (done but needs human review), completed (work finished successfully), progress (milestone update)',
      ),
    message: tool.schema
      .string()
      .describe('Human-readable status message'),
    progress: tool.schema
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe('Completion percentage (0-100)'),
  },
  async execute(args) {
    const cwd = process.cwd();
    const managed = await isInManagedWorktree(cwd);

    if (!managed.isManaged || !managed.jobName) {
      throw new Error(
        'mc_report can only be used from within a managed Mission Control worktree.',
      );
    }

    const state = await loadJobState();
    // Match only running jobs to avoid picking up stale entries from previous runs
    // that share the same name/worktree path
    const job = state.jobs.find(
      (j) =>
        j.status === 'running' &&
        (j.worktreePath === managed.worktreePath ||
         j.name === managed.jobName),
    ) ?? state.jobs.find(
      (j) =>
        j.worktreePath === managed.worktreePath ||
        j.name === managed.jobName,
    );

    if (!job) {
      throw new Error(
        `No active job found for worktree "${managed.worktreePath}". The job may have been cleaned up.`,
      );
    }

    await writeReport({
      jobId: job.id,
      jobName: job.name,
      status: args.status as ReportStatus,
      message: args.message,
      progress: args.progress,
      timestamp: new Date().toISOString(),
    });

    const progressSuffix =
      args.progress !== undefined ? ` (${args.progress}%)` : '';
    return `Report submitted: [${args.status}]${progressSuffix} ${args.message}`;
  },
});

/**
 * M5/M7: standardized final report assembled from live state.
 * Readable body up front (request → verified vs gaps → next steps);
 * long per-job messages stay referenced here and attached as annexes.
 * Never invents percentages or results: unknown work is listed under
 * Gaps (Unmet / Unverified), never under Verified.
 */
export const mc_report_final: ToolDefinition = tool({
  description:
    'Assemble the standardized final mission report from the active plan, jobs, and milestone reports',
  args: {
    notes: tool.schema
      .string()
      .optional()
      .describe('Extra operator notes appended under Real Evidence'),
    includeAttachments: tool.schema
      .boolean()
      .optional()
      .describe('Attach full per-job report messages as annexes (default true)'),
  },
  async execute(args) {
    const plan = await loadPlan();
    if (!plan) {
      throw new Error('No active plan to report on');
    }
    // F09: never throw on missing sidecar — an absent intake/evidence file
    // means "no conserved evidence yet", not a report failure. Real data is
    // used when present; empties below only reflect genuinely missing input.
    const [state, reports, snap, mergeEvidence] = await Promise.all([
      loadJobState(),
      readAllReports(),
      import('../lib/durable-state').then((m) => m.loadRuntimeSnapshot().catch(() => null)),
      import('../lib/durable-state').then((m) => m.loadMergeEvidence().catch(() => ({}))),
    ]);
    const intake = (snap as { autoIntake?: { request?: string; requirements?: Array<{ id: string; text: string }>; decisions?: string[]; questions?: string[] } | null } | null)?.autoIntake ?? null;
    const withAttachments = args.includeAttachments ?? true;

    const tasks = plan.jobs.map((job) => {
      const appr = (job as unknown as { reviewApproval?: { actor?: string; actorEvidence?: string; reviewedCommit?: string } }).reviewApproval;
      const baseDetail = job.error ?? (job.mergedAt ? `merged at ${job.mergedAt}` : undefined);
      // Lane F cav-2.1: human é auto-declaração não atestada — nunca afirmar como fato.
      // M6: rótulo canônico via formatActorLabel (human/com-ressalva vs não-humano vs desconhecido).
      if (appr) {
        const extra = `aceite ${formatActorLabel(appr.actor)} @ ${appr.reviewedCommit?.slice(0, 8) ?? '?'} — COM RESSALVA (permanece Unverified, sem selo verified; aceite nunca Verified)`;
        return { name: job.name, status: job.status, detail: baseDetail ? `${baseDetail}; ${extra}` : extra };
      }
      return {
        name: job.name,
        status: job.status,
        detail: baseDetail,
      };
    });
    const merged = plan.jobs.filter((job) => job.status === 'merged').map((job) => job.name);
    const conflicts = plan.jobs
      .filter((job) => job.status === 'conflict' || job.status === 'needs_rebase')
      .map((job) => job.name);
    // Fail-closed, two distinct claims (unified strict rule — see verification.ts):
    // - integrated = merged into the integration branch (a merge happened).
    // - verified = merged AND backed by TASK-scoped passing product evidence
    //   (scoped review run on the candidate with reviewedCommit, not
    //   acceptance-less). Integration-only smoke never verifies; it renders
    //   under Gaps. Unknown work stays under Gaps, never under Verified.
    const evidenceRecs = Object.values(mergeEvidence as Record<string, { testStatus?: string; testCommand?: string; reviewedCommit?: string; scope?: string; acceptanceLess?: boolean }>);
    const { isTaskVerified, isTrivialTestCommand } = await import('../lib/verification.js');
    const trivialOf = (name: string): string | null => {
      const rec = (mergeEvidence as Record<string, { testCommand?: string }>)[name];
      return rec?.testCommand && isTrivialTestCommand(rec.testCommand) ? rec.testCommand : null;
    };
    // R2: retry operacional (sem reviewApproval) pode verificar via gates;
    // accept (com reviewApproval) nunca — fail-closed mesmo com task-scoped pass
    // (ex.: pass anterior + aceite posterior). retry ≠ accept em todos os escopos.
    const acceptedByJob = new Map(
      plan.jobs
        .filter((job) => (job as unknown as { reviewApproval?: unknown }).reviewApproval)
        .map((job) => [job.name, (job as unknown as { reviewApproval: { actor?: string } }).reviewApproval.actor] as const),
    );
    const verifiedCandidates = merged
      .filter((name) => isTaskVerified((mergeEvidence as Record<string, Record<string, unknown>>)[name] as never))
      .map((name) => {
        const rec = (mergeEvidence as Record<string, { testCommand?: string; reviewedCommit?: string }>)[name];
        return `${name} [merged, task-scoped]${rec?.testCommand ? ` ${rec.testCommand} passed` : ''}${rec?.reviewedCommit ? ` @ ${rec.reviewedCommit.slice(0, 8)}` : ''}`;
      });
    const verified = excludeAcceptedFromVerified(verifiedCandidates, [...acceptedByJob.keys()]);
    // Trivial no-op (`true`/echo puro) nunca verifica: fora de Verified
    // (via isTaskVerified) e fora do smoke global — gap explícito próprio.
    const trivialNames = merged.filter((name) => trivialOf(name) !== null);
    const trivialGaps = trivialNames.map((name) => `${name} [merged] — comando de teste trivial "${trivialOf(name)}" (no-op, não é verificação funcional), outcome not verified`);
    const integrationCovered = merged
      .filter((name) => !isTaskVerified((mergeEvidence as Record<string, Record<string, unknown>>)[name] as never) && (mergeEvidence as Record<string, { testStatus?: string }>)[name]?.testStatus === 'passed' && trivialOf(name) === null)
      .map((name) => {
        const rec = (mergeEvidence as Record<string, { testCommand?: string }>)[name];
        return `${name} [merged] — covered only by global integration smoke${rec?.testCommand ? ` (${rec.testCommand})` : ''}, no task-scoped verification`;
      });
    // R2: todo aceite merged rende gap explícito com ressalva (nunca silencioso,
    // nunca Verified) — inclusive sem evidência task-scoped (invisível antes).
    const verifiedNames = new Set(
      verified.map((entry) => merged.find((name) => entry === name || entry.startsWith(`${name} `) || entry.startsWith(`${name} [`)) ?? entry),
    );
    const integrationNames = new Set(
      integrationCovered.map((entry) => merged.find((name) => entry.startsWith(`${name} `) || entry.startsWith(`${name} [`)) ?? entry),
    );
    const acceptGaps = [...acceptedByJob.entries()]
      .filter(([name]) => merged.includes(name) && !verifiedNames.has(name))
      .map(([name, actor]) => formatAcceptGap(name, actor));
    const silentMergedGaps = merged
      .filter((name) => !verifiedNames.has(name) && !integrationNames.has(name) && !acceptedByJob.has(name) && trivialOf(name) === null)
      .map((name) => `${name} [merged] — sem evidência task-scoped, outcome not verified`);
    const unmet = plan.jobs
      .filter((job) => job.status === 'failed' || job.status === 'conflict' || job.status === 'needs_rebase' || job.status === 'canceled')
      .map((job) => `${job.name} [${job.status}]${job.error ? `: ${job.error}` : ''}`);
    // Anything not merged is unverified — including completed jobs: a worker
    // "completed" claim without a merge (no reviewer gate, no integration)
    // is not evidence. Merged jobs with only integration smoke (no task
    // evidence) also render here under Gaps, never under Verified.
    // Pending human decisions always listed (parity with auto-report).
    let pendingGaps: string[] = [];
    try {
      const persisted = (snap as { pendingQuestions?: Array<{ jobId: string; question: string; partId?: string }> } | null)?.pendingQuestions ?? [];
      const qs = [
        ...((intake as { questions?: string[] } | null)?.questions ?? []),
        // M6: escalações de permissão (ask-user, timeout=Deny) rotuladas como
        // tal quando o partId persistido indica perm:; demais seguem genéricas.
        ...persisted.map((q) => (q.partId?.startsWith('perm:')
          ? `permission escalation pendente (ask-user, timeout=Deny): [${q.jobId}] ${q.question}`
          : `[${q.jobId}] ${q.question}`)),
      ];
      pendingGaps = qs.map((q) => q.startsWith('permission escalation')
        ? q
        : `pending human decision (blocks acceptance): ${q}`);
    } catch {
      pendingGaps = [];
    }
    const unverified = [
      ...plan.jobs
        .filter((job) => job.status !== 'merged')
        .filter((job) => !unmet.some((entry) => entry.startsWith(`${job.name} `)))
        .map((job) => `${job.name} [${job.status}] — outcome not verified`),
      ...integrationCovered.map((entry) => `${entry}`),
      ...trivialGaps.map((entry) => `${entry}`),
      ...acceptGaps,
      ...silentMergedGaps,
      ...pendingGaps,
    ];
    // M8: merged sem mc_report entram no total do header com o texto canônico
    // de buildFinalReportMarkdown — o filtro `entry.includes(name)` de lá
    // evita duplicar na seção Gaps, então header e Gaps mostram o mesmo total.
    // (Só contagem aqui: `unverified` passado ao markdown fica inalterado
    // para não duplicar Problems derivados.)
    const haveReports = new Set(reports.map((report) => report.jobName));
    const missingReportNames = merged
      .filter((name) => !haveReports.has(name))
      .filter((name) => !unverified.some((entry) => entry.includes(name)));
    const unverifiedForCount = [
      ...unverified,
      ...missingReportNames.map((name) => `missing per-instance report for "${name}" (merged without mc_report)`),
    ];
    const unverifiedTotal = unverifiedForCount.length;
    const gapDetail = describeGapCategories(unverifiedForCount);
    // Operator notes are labeled as such under Real Evidence — they are
    // human claims, never automatic product evidence.
    const notes = args.notes?.trim() ? [`Operator note: ${args.notes.trim()}`] : [];
    const files = [...new Set(evidenceRecs.flatMap((r) => (r as { changedFiles?: string[] }).changedFiles ?? []))];
    const installUsage = [...new Set(evidenceRecs.flatMap((r) => {
      const rec = r as { setupCommands?: string[]; testCommand?: string };
      return [...(rec.setupCommands ?? []), ...(rec.testCommand ? [rec.testCommand] : [])];
    }))];
    const tests = evidenceRecs
      .filter((r) => (r as { testCommand?: string }).testCommand)
      .map((r) => {
        const rec = r as { testCommand?: string; testStatus?: string; testOutput?: string };
        const trivial = !!rec.testCommand && isTrivialTestCommand(rec.testCommand);
        return {
          command: rec.testCommand!,
          result: trivial && (rec.testStatus ?? 'skipped') === 'passed'
            ? 'passed (no-op, não é verificação funcional)'
            : (rec.testStatus ?? 'skipped'),
          output: rec.testOutput,
        };
      });
    const decisions = [
      ...((intake as { decisions?: string[] } | null)?.decisions ?? []),
      ...((plan.auditLog ?? []) as Array<{ action: string; jobName?: string; actor?: string; actorEvidence?: string }>).map(
        (a) => `${a.action}${a.jobName ? ` ${a.jobName}` : ''} — ${formatActorLabel(a.actor)}${a.actorEvidence ? ` (${a.actorEvidence.slice(0, 120)})` : ''}`,
      ),
    ];
    // OMO status declared explicitly (never a silent success): without OMO
    // the report records vanilla-only execution as the limitation.
    // missingContributionJobs needs no separate call — buildFinalReportMarkdown
    // already names merged jobs without mc_report under Per-Instance
    // Contributions and Gaps.
    let omoLine = 'Limitation: OMO status unknown — vanilla execution only.';
    // M6: disponível vs carregado vs efetivamente utilizado (detecção nunca é uso).
    const modesUsed = [...new Set(state.jobs.map((j) => j.mode))];
    const modesStr = modesUsed.join(', ') || 'none';
    let omoEnv = `OMO (disponível: status desconhecido; carregado: sem evidência runtime; utilizado: não — effective modes: ${modesStr}; detection is not use).`;
    try {
      const omo = await detectOMO().catch(() => null);
      if (omo) {
        omoLine = describeOmoLimitation(omo.detected, omo.configSource ?? undefined);
        omoEnv = omo.detected
          ? `OMO (disponível: detectado em config ${omo.configSource ?? 'unknown'}; carregado: sem evidência runtime; utilizado: não — effective modes this run: ${modesStr}; detection is not use).`
          : `OMO (disponível: não detectado — vanilla execution only; carregado: n/a; utilizado: não — effective modes: ${modesStr}).`;
      }
    } catch {
      // Best-effort: the unknown-status line above already fails closed.
    }
    // M6: plugins/skills em leitura apenas (sem alterar perfil global) —
    // configurado não prova carregado, e nada disso prova utilizado.
    let pluginEnv = 'plugins (disponível: ./opencode.json ilegível/ausente; carregado: sem evidência runtime; utilizado: nenhum comprovado — configuração não é uso).';
    try {
      const raw = await Bun.file('./opencode.json').text();
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      const names = (['plugin', 'plugins'] as const).flatMap((k) => {
        const v = cfg[k];
        return Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
      }).filter((x): x is string => typeof x === 'string');
      pluginEnv = names.length > 0
        ? `plugins (disponível: declarados em ./opencode.json: ${names.join(', ')}; carregado: sem evidência runtime; utilizado: nenhum comprovado — configuração não é uso).`
        : 'plugins (disponível: nenhum declarado em ./opencode.json; carregado: sem evidência runtime; utilizado: nenhum comprovado).';
    } catch {
      // Best-effort: a linha padrão acima já declara o desconhecido.
    }
    const skillEnv = 'skills (disponível: sem inventário afirmado; carregado: sem evidência runtime; utilizado: nenhuma skill comprovadamente utilizada neste run).';

    // Used vs detected, from the records the run wrote (jobs.json pins are
    // server-observed, never config claims): per-job effective mode, agent
    // when set, and requested/observed model triple (variant preserved).
    const environment: string[] = [
      ...state.jobs.map((job) => {
        const agent = (job as { agent?: string }).agent;
        const req = job.modelRequested
          ? `${job.modelRequested.providerID}/${job.modelRequested.id}${job.modelRequested.variant ? `#${job.modelRequested.variant}` : ''}`
          : 'none';
        const obs = job.modelObserved
          ? `${job.modelObserved.providerID}/${job.modelObserved.id}${job.modelObserved.variant ? `#${job.modelObserved.variant}` : ''} (server-observed, used)`
          : 'none (unpinned/TUI path)';
        return `${job.name} [mode ${job.mode}, agent ${agent ?? 'unset'}] requested ${req} / observed ${obs}${job.remoteSessionID ? ` session ${job.remoteSessionID}` : ''}`;
      }),
      omoEnv,
      pluginEnv,
      skillEnv,
    ];

    // M6: ramos não exercitados pertinentes + budget auto-fix, ambos a partir
    // de registros reais (nunca valores afirmados sem evidência).
    const allDecisions = decisions.join('\n');
    const autoFixMatches = [...allDecisions.matchAll(/auto-fix attempt (\d+)\/(\d+)/g)];
    let autoFixLine: string;
    if (autoFixMatches.length > 0) {
      const used = Math.max(...autoFixMatches.map((m) => Number(m[1])));
      const budget = autoFixMatches[0]![2];
      const exhausted = /auto-fix budget exhausted/i.test(allDecisions);
      autoFixLine = `auto-fix: ${used}/${budget} tentativa(s) usada(s) (budget ${budget}, de 'auto-fix attempt N/${budget}' nos registros)${exhausted ? ' — budget esgotado, escalado ao operador' : ''}`;
    } else {
      autoFixLine = 'auto-fix: nenhuma tentativa registrada nos decisions — budget não observável nos registros (não afirmar valor)';
    }
    // fix-before-rollback só existe para jobs serve-mode (port + sessão
    // remota); fora disso o merge segue para rollback direto em falha de teste.
    const serveJobs = state.jobs.filter((j) => (j.port ?? 0) > 0 && j.remoteSessionID);
    const nonServeJobs = state.jobs.filter((j) => !((j.port ?? 0) > 0 && j.remoteSessionID));
    const fixRollbackLine = serveJobs.length > 0
      ? `fix-before-rollback: disponível para ${serveJobs.map((j) => j.name).join(', ')} (serve-mode com sessão remota)${nonServeJobs.length > 0 ? `; inativo para ${nonServeJobs.map((j) => j.name).join(', ')} (sem port/remoteSessionID — falha de teste segue para rollback direto)` : ''}`
      : 'fix-before-rollback: ramo não exercitado neste run (nenhum job serve-mode com sessão remota; falha de teste segue para rollback direto)';
    const permissionLogLine = 'decisionLog de permissões (policy): efêmero em runtime, não conservado em estado persistido — sem anexo; escalações ask-user (timeout=Deny) aparecem em Gaps quando persistidas como pendingQuestions';

    // M6: "nenhum accept usado" explícito quando for o caso; com aceites, a
    // lista sob ressalva (nunca Verified por aceite — regra Lane F preservada).
    const acceptJobs = plan.jobs.filter((job) => (job as unknown as { reviewApproval?: unknown }).reviewApproval);
    const acceptDecisionCount = allDecisions.split('\n').filter((d) => /approve accept|operator accept honored/i.test(d)).length;
    const noAcceptLine = acceptJobs.length === 0 && acceptDecisionCount === 0
      ? 'Nenhum review accept usado neste run (nenhum aceite registrado — sem ressalvas pendentes por aceite)'
      : null;

    const markdown = buildFinalReportMarkdown({
      title: plan.name,
      request: intake?.request?.trim() ? intake.request.trim() : `Plan "${plan.name}" (${plan.mode}) — ${plan.jobs.length} job(s).`,
      scope: intake?.requirements?.length ? intake.requirements.map((r) => `${r.id}: ${r.text}`) : plan.jobs.map((job) => job.name),
      architecture: [`Integration branch: ${plan.integrationBranch}`, `Base commit: ${plan.baseCommit}`],
      decisions,
      tasks,
      contributions: reports.map((report) => ({
        instance: report.jobId,
        job: report.jobName,
        summary: `[${report.status}] ${report.message}`,
      })),
      files,
      branches: [
        plan.integrationBranch,
        ...plan.jobs.map((job) => job.branch).filter((branch): branch is string => Boolean(branch)),
      ],
      integration: {
        branch: plan.integrationBranch,
        merged,
        conflicts,
        note: plan.prUrl ? `PR: ${plan.prUrl}` : 'Local completion only; no push/PR without explicit humanAuth',
      },
      installUsage,
      tests,
      evidences: [
        ...evidenceRecs.map((r) => {
          const rec = r as { jobName?: string; testStatus?: string; testCommand?: string; reviewedCommit?: string; testOutput?: string };
          return `${rec.jobName ?? 'job'} [${rec.testStatus ?? 'skipped'}]${rec.testCommand ? ` ${rec.testCommand}` : ''}${rec.reviewedCommit ? ` @ ${rec.reviewedCommit.slice(0, 8)}` : ''}${rec.testOutput ? ` — ${rec.testOutput.slice(0, 200)}` : ''}`;
        }),
        // Lane F cav-2.1: aceites exibidos como evidência rotulada (auto-declaração nunca como fato) + ressalva.
        // M6: rótulo canônico via formatActorLabel; sem aceites, linha explícita (nunca silêncio).
        ...(noAcceptLine ? [noAcceptLine] : []),
        ...plan.jobs
          .filter((job) => (job as unknown as { reviewApproval?: unknown }).reviewApproval)
          .map((job) => {
            const appr = (job as unknown as { reviewApproval: { actor?: string; reviewedCommit?: string; reason?: string } }).reviewApproval;
            return `accept "${job.name}" por ${formatActorLabel(appr.actor)} @ ${appr.reviewedCommit?.slice(0, 8) ?? '?'} — COM RESSALVA (permanece Unverified, sem selo verified; aceite nunca Verified)`;
          }),
        ...notes,
        `Plan status: ${plan.status}${plan.prUrl ? ` — PR: ${plan.prUrl}` : ''}`,
      ],
      problems: (() => {
        // Lane F: Problems de registros reais (resolvido/pendente/desconhecido).
        const base = [
          ...unmet.map((entry) => ({
            problem: entry,
            solution: 'See job error and retry via mc_plan_approve',
            status: 'pendente' as const,
          })),
          ...trivialNames.map((name) => ({
            problem: `comando de teste trivial "${trivialOf(name)}" em "${name}" (no-op, não é verificação funcional) — sem verificação funcional`,
            solution: 'configurar comando de teste funcional (ex.: bun test / node --test) e re-verificar por critério',
            status: 'pendente' as const,
          })),
        ];
        const derived = deriveProblemsFromRecords({
          title: plan.name,
          decisions,
          tasks: tasks.map((t) => ({ name: t.name, status: t.status, detail: t.detail ?? undefined })),
          contributions: reports.map((report) => ({ instance: report.jobId, job: report.jobName, summary: `[${report.status}] ${report.message}` })),
          integration: { branch: plan.integrationBranch, merged, conflicts },
          verified: [],
          unmet,
          unverified,
        });
        const seen = new Set(base.map((b) => b.problem.slice(0, 160)));
        const mergedProblems = [...base];
        for (const d of derived) {
          const key = d.problem.slice(0, 160);
          if (seen.has(key)) continue;
          seen.add(key);
          mergedProblems.push(d);
        }
        return mergedProblems;
      })(),
      verified,
      unmet,
      unverified,
      environment,
      limitations: ['Local completion only; no push/PR without explicit humanAuth', omoLine, autoFixLine, fixRollbackLine, permissionLogLine, '--actor human é auto-declaração não verificada (origem não comprovada; humano necessário nunca simulado pelo agente — --actor human não comprova humano)'],
      nextSteps: unverified.length > 0 || unmet.length > 0
        ? ['Resolve the Gaps above, then re-run this report']
        : [],
      preservation: {
        preserved: state.jobs
          .filter((job) => job.status === 'running' || job.status === 'completed')
          .map((job) => `${job.name} [${job.status}] — code preserved in ${job.branch} (${job.worktreePath ?? 'no worktree'})`),
        closed: merged.map((name) => `${name} — merged into ${plan.integrationBranch}`),
        cleanup: [],
      },
      attachments: withAttachments
        ? [
          ...reports.map((report) => ({
            name: `${report.jobName} [${report.status}] @ ${report.timestamp}`,
            content: report.progress !== undefined
              ? `${report.message} (${report.progress}%)`
              : report.message,
          })),
          ...evidenceRecs.map((r) => {
            const rec = r as { jobName?: string; testStatus?: string; mergedAt?: string; testCommand?: string; reviewedCommit?: string; reviewedBase?: string; testOutput?: string };
            return {
              name: `MergeTestReport ${rec.jobName ?? 'job'} [${rec.testStatus ?? 'skipped'}] @ ${rec.mergedAt ?? 'unknown'}`,
              content: [
                rec.testCommand ? `command: ${rec.testCommand}` : null,
                `status: ${rec.testStatus ?? 'skipped'}`,
                rec.reviewedCommit ? `reviewedCommit: ${rec.reviewedCommit}` : null,
                rec.reviewedBase ? `reviewedBase: ${rec.reviewedBase}` : null,
                rec.testOutput ? `output:\n${rec.testOutput.slice(0, 4000)}` : null,
              ].filter(Boolean).join('\n') || '(no test output)',
            };
          }),
        ]
        : [],
    });

    const filePath = await writeFinalReport(plan.id, markdown);
    return [
      `Final report for plan "${plan.name}" written to ${filePath}.`,
      '',
      `Integrated: ${merged.length}, Unmet: ${unmet.length}, Unverified: ${unverifiedTotal}${gapDetail ? ` (${gapDetail})` : ''}.`,
      'Merges are integration, not verification: a merge alone does not prove functioning.',
      'Long logs are in Annexes; unknown work is under Gaps, never under Verified.',
    ].join('\n');
  },
});
