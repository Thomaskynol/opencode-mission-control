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
      if (appr) {
        const actorLabel =
          appr.actor === 'human'
            ? 'ator human (auto-declarado via --actor, sem atestação fora de banda — não verificado)'
            : appr.actor
              ? `ator ${appr.actor} (não-humano)`
              : 'ator desconhecido (desconhecido)';
        const extra = `aceite ${actorLabel} @ ${appr.reviewedCommit?.slice(0, 8) ?? '?'} — COM RESSALVA (permanece Unverified, sem selo verified)`;
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
    const { isTaskVerified } = await import('../lib/verification.js');
    const verified = merged
      .filter((name) => isTaskVerified((mergeEvidence as Record<string, Record<string, unknown>>)[name] as never))
      .map((name) => {
        const rec = (mergeEvidence as Record<string, { testCommand?: string; reviewedCommit?: string }>)[name];
        return `${name} [merged, task-scoped]${rec?.testCommand ? ` ${rec.testCommand} passed` : ''}${rec?.reviewedCommit ? ` @ ${rec.reviewedCommit.slice(0, 8)}` : ''}`;
      });
    const integrationCovered = merged
      .filter((name) => !isTaskVerified((mergeEvidence as Record<string, Record<string, unknown>>)[name] as never) && (mergeEvidence as Record<string, { testStatus?: string }>)[name]?.testStatus === 'passed')
      .map((name) => {
        const rec = (mergeEvidence as Record<string, { testCommand?: string }>)[name];
        return `${name} [merged] — covered only by global integration smoke${rec?.testCommand ? ` (${rec.testCommand})` : ''}, no task-scoped verification`;
      });
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
      const persisted = (snap as { pendingQuestions?: Array<{ jobId: string; question: string }> } | null)?.pendingQuestions ?? [];
      const qs = [
        ...((intake as { questions?: string[] } | null)?.questions ?? []),
        ...persisted.map((q) => `[${q.jobId}] ${q.question}`),
      ];
      pendingGaps = qs.map((q) => `pending human decision (blocks acceptance): ${q}`);
    } catch {
      pendingGaps = [];
    }
    const unverified = [
      ...plan.jobs
        .filter((job) => job.status !== 'merged')
        .filter((job) => !unmet.some((entry) => entry.startsWith(`${job.name} `)))
        .map((job) => `${job.name} [${job.status}] — outcome not verified`),
      ...integrationCovered.map((entry) => `${entry}`),
      ...pendingGaps,
    ];
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
        return { command: rec.testCommand!, result: rec.testStatus ?? 'skipped', output: rec.testOutput };
      });
    const decisions = [
      ...((intake as { decisions?: string[] } | null)?.decisions ?? []),
      ...((plan.auditLog ?? []) as Array<{ action: string; jobName?: string; actor?: string; actorEvidence?: string }>).map(
        (a) => `${a.action}${a.jobName ? ` ${a.jobName}` : ''}${a.actor ? (a.actor === 'human' ? ' — ator human (auto-declarado via --actor, sem atestação fora de banda — não verificado)' : ` — ator ${a.actor} (não-humano)`) : ''}${a.actorEvidence ? ` (${a.actorEvidence.slice(0, 120)})` : ''}`,
      ),
    ];
    // OMO status declared explicitly (never a silent success): without OMO
    // the report records vanilla-only execution as the limitation.
    // missingContributionJobs needs no separate call — buildFinalReportMarkdown
    // already names merged jobs without mc_report under Per-Instance
    // Contributions and Gaps.
    let omoLine = 'Limitation: OMO status unknown — vanilla execution only.';
    let omoEnv = 'OMO status unknown — vanilla execution only (detection is not use).';
    try {
      const omo = await detectOMO().catch(() => null);
      if (omo) {
        omoLine = describeOmoLimitation(omo.detected, omo.configSource ?? undefined);
        const modesUsed = [...new Set(state.jobs.map((j) => j.mode))];
        omoEnv = omo.detected
          ? `OMO detected (${omo.configSource ?? 'unknown'} config) — NOT used: effective modes this run: ${modesUsed.join(', ') || 'none'}; detection is not use.`
          : `OMO not detected — vanilla execution only (effective modes: ${modesUsed.join(', ') || 'none'}).`;
      }
    } catch {
      // Best-effort: the unknown-status line above already fails closed.
    }

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
    ];

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
        ...plan.jobs
          .filter((job) => (job as unknown as { reviewApproval?: unknown }).reviewApproval)
          .map((job) => {
            const appr = (job as unknown as { reviewApproval: { actor?: string; reviewedCommit?: string; reason?: string } }).reviewApproval;
            const label =
              appr.actor === 'human'
                ? 'human (auto-declarado via --actor, sem atestação fora de banda — não verificado)'
                : appr.actor
                  ? `${appr.actor} (não-humano)`
                  : 'desconhecido (desconhecido)';
            return `accept "${job.name}" por ${label} @ ${appr.reviewedCommit?.slice(0, 8) ?? '?'} — COM RESSALVA (permanece Unverified, sem selo verified)`;
          }),
        ...notes,
        `Plan status: ${plan.status}${plan.prUrl ? ` — PR: ${plan.prUrl}` : ''}`,
      ],
      problems: (() => {
        // Lane F: Problems de registros reais (resolvido/pendente/desconhecido).
        const base = unmet.map((entry) => ({
          problem: entry,
          solution: 'See job error and retry via mc_plan_approve',
          status: 'pendente' as const,
        }));
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
      limitations: ['Local completion only; no push/PR without explicit humanAuth', omoLine],
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
      `Integrated: ${merged.length}, Unmet: ${unmet.length}, Unverified: ${unverified.length}.`,
      'Merges are integration, not verification: a merge alone does not prove functioning.',
      'Long logs are in Annexes; unknown work is under Gaps, never under Verified.',
    ].join('\n');
  },
});
