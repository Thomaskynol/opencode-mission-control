import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { randomUUID } from 'crypto';
import { getJobByName, addJob, getRunningJobs, type Job } from '../lib/job-state';
import { createWorktree, removeWorktree, deleteBranchIfUnused } from '../lib/worktree';
import {
  createSession,
  createWindow,
  killSession,
  killWindow,
  setPaneDiedHook,
  sendKeys,
  getCurrentSession,
  isInsideTmux,
  isTmuxAvailable,
} from '../lib/tmux';
import { loadConfig, assertPluginDistReady, assertOmoModeAvailable } from '../lib/config';
import { buildWorktreePermissions, assertPolicyFloorCompliant } from '../lib/permission-policy';
import { copyPlansToWorktree } from '../lib/plan-copier';
import { resolvePostCreateHook, assertNoPermissiveOpencodeConfig } from '../lib/worktree-setup';
import { getMainWorktree } from '../lib/worktree';
import { writePromptFile, cleanupPromptFile, writeLauncherScript, cleanupLauncherScript, writeServeLauncherScript, describeTuiModelPin, TUI_MODEL_BLOCKADE } from '../lib/prompt-file';
import { getCurrentModel, getCurrentModelInfo } from '../lib/model-tracker';
import { allocatePort, releasePort } from '../lib/port-allocator';
import {
  quoteShellPath,
  launchWorkerViaServe,
  v2WaitForServer,
} from '../lib/sdk-client';

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ownership probe: does `refs/heads/<branch>` exist? Exact ref lookup —
 * never substring (`mc/job` must not match `mc/job-2`). Fail-closed: any
 * git error counts as pre-existing so rollback never deletes a branch we
 * did not verify as ours.
 */
export async function checkBranchPreExisted(branch: string, opts?: { cwd?: string }): Promise<boolean> {
  try {
    const { gitCommand } = await import('../lib/git');
    const pre = await gitCommand(['rev-parse', '--verify', `refs/heads/${branch}`], opts?.cwd ? { cwd: opts.cwd } : undefined);
    return pre.exitCode === 0;
  } catch {
    return true;
  }
}

const AUTO_COMMIT_SUFFIX = `

IMPORTANT: When you have completed ALL of your work, you MUST commit your changes before finishing. Stage all modified and new files, then create a commit with a conventional commit message (e.g. "feat: ...", "fix: ...", "docs: ...", "refactor: ...", "chore: ..."). Do NOT skip this step.`;

const MC_REPORT_SUFFIX = `

CRITICAL — STATUS REPORTING REQUIRED:
You MUST call the mc_report tool at these points — this is NOT optional:

1. IMMEDIATELY when you start: mc_report(status: "working", message: "Starting: <brief description>")
2. At each major milestone: mc_report(status: "progress", message: "<what you accomplished>", progress: <0-100>)
3. If you get stuck or need input: mc_report(status: "blocked", message: "<what's blocking you>")
4. WHEN YOU ARE COMPLETELY DONE: mc_report(status: "completed", message: "<summary of what was done>")

The "completed" call is MANDATORY — it signals Mission Control that your job is finished. Without it, your job will appear stuck as "running" and block the pipeline. Always call mc_report(status: "completed", ...) as your FINAL action.

If your work needs human review before it can proceed: mc_report(status: "needs_review", message: "<what needs review>")`;

const WORKTREE_LOCAL_SUFFIX = `

WORKTREE SCOPE: Work only inside your current worktree and branch with relative paths — never \`cd\` outside, never reference absolute origin paths. Your session directory is your project root.`;

function buildFullPrompt(opts: {
  prompt: string;
  mode: string;
  planFile?: string;
  autoCommit?: boolean;
}): string {
  let prompt = opts.prompt + WORKTREE_LOCAL_SUFFIX + MC_REPORT_SUFFIX;
  if (opts.autoCommit !== false) {
    prompt += AUTO_COMMIT_SUFFIX;
  }

  switch (opts.mode) {
    case 'plan':
      if (opts.planFile) {
        return `${prompt} Plan file: ${opts.planFile}`;
      }
      return prompt;
    case 'ralph':
      return `/ralph-loop ${prompt}`;
    case 'ulw':
      return `/ulw-loop ${prompt}`;
    case 'vanilla':
    default:
      return prompt;
  }
}

export const mc_launch: ToolDefinition = tool({
  description:
    'Launch a new parallel AI coding session in an isolated worktree',
  args: {
    name: tool.schema
      .string()
      .describe('Job name (used for branch and tmux)'),
    prompt: tool.schema.string().describe('Task prompt for the AI agent'),
    branch: tool.schema
      .string()
      .optional()
      .describe('Branch name (defaults to mc/{name})'),
    baseBranch: tool.schema
      .string()
      .optional()
      .describe('Branch or ref to start from (defaults to default branch)'),
    placement: tool.schema
      .enum(['session', 'window'])
      .optional()
      .describe('tmux placement: session (default) or window'),
    mode: tool.schema
      .enum(['vanilla', 'plan', 'ralph', 'ulw'])
      .optional()
      .describe('Execution mode'),
    planFile: tool.schema
      .string()
      .optional()
      .describe('Plan file to use (for plan mode)'),
    copyFiles: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe('Files to copy from main worktree (e.g. [".env", ".env.local"])'),
    agent: tool.schema
      .string()
      .optional()
      .describe('Serve worker agent (passed as the session agent profile; TUI ignores it)'),
    symlinkDirs: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe('Directories to symlink from main worktree (e.g. ["node_modules"]). .opencode is always included.'),
    commands: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe('Shell commands to run in worktree after creation (e.g. ["bun install"])'),
  },
  async execute(args, context) {
    // 0. Validate tmux is available
    const tmuxFound = await isTmuxAvailable();
    if (!tmuxFound) {
      throw new Error(
        'tmux is required but not found. Install tmux to use Mission Control: https://github.com/tmux/tmux',
      );
    }

    // 1. Validate name uniqueness
    const existing = await getJobByName(args.name);
    if (existing) {
      throw new Error(
        `Job "${args.name}" already exists (status: ${existing.status}). Use a different name or cleanup the existing job first.`,
      );
    }

    // 2. Load config for defaults
    const config = await loadConfig();

    // 2b. Policy pre-flight (lane-policy): verify the necessary policy
    // BEFORE execution, or block the mode that cannot meet restrictions.
    // A permissive global policy would let reserved actions run without a
    // decisor (fail-open) — refuse fail-closed with an actionable message.
    assertPolicyFloorCompliant(config.defaultPermissionPolicy, 'global');
    // TUI mode cannot enforce session permissions (no serve session, no
    // permission.asked events for the monitor) — block with guidance.
    if (config.useServeMode === false) {
      throw new Error(
        '[MC] Refusing launch: TUI mode (useServeMode:false) cannot enforce the permission policy ' +
          '(no session permissions, no monitor permission events). Use serve mode (useServeMode:true, the default) ' +
          'so in-worktree allow / outside ask-or-deny + operator questions (mc_answer) hold.',
      );
    }
    // Inherited `.opencode`/opencode.json with blanket allow would let the
    // server allow without asking the monitor (no event to contain) — block.
    try {
      const mainPath = await getMainWorktree();
      assertNoPermissiveOpencodeConfig(mainPath);
    } catch (error) {
      if (error instanceof Error && error.message.includes('permissive opencode permission')) throw error;
      // No main worktree determinable (fresh repo): nothing inherited to vet.
    }

    // 3. Resolve parameters
    const jobId = randomUUID();
    const branch = args.branch ?? `mc/${args.name}`;
    const placement = args.placement ?? config.defaultPlacement;
    const mode = args.mode ?? config.omo.defaultMode;

    // 3b. Dispatch pre-flight (fail-fast BEFORE any worktree exists):
    // dist/ must be built and non-vanilla modes require a detected OMO.
    assertPluginDistReady();
    await assertOmoModeAvailable(mode);

    const sanitizedName = args.name.replace(/[^a-zA-Z0-9_-]/g, '-');

    // tmux target naming
    const tmuxSessionName = `mc-${sanitizedName}`;
    const tmuxTarget =
      placement === 'session'
        ? tmuxSessionName
        : (() => {
            const currentSession = getCurrentSession();
            if (!currentSession && !isInsideTmux()) {
              throw new Error(
                'Window placement requires being inside a tmux session. Use session placement instead, or run from within tmux.',
              );
            }
            return `${currentSession}:${sanitizedName}`;
          })();

    // 4. Create worktree with setup hooks
    const postCreate = resolvePostCreateHook(
      config.worktreeSetup,
      {
        copyFiles: args.copyFiles,
        symlinkDirs: args.symlinkDirs,
        commands: args.commands,
      },
    );

    let worktreePath: string;
    // Blocker 1: ownership probe BEFORE creation. A pre-existing branch is
    // reused, never owned — rollback deletes only what this launch created.
    // Exact ref lookup (never substring): `mc/job` must not collide with
    // an existing `mc/job-2`.
    const branchPreExisted = await checkBranchPreExisted(branch);
    // Best-effort compensation: remove the worktree AND the owned branch.
    // deleteBranchIfUnused re-verifies mc/ prefix + worktree use, so a
    // foreign branch is never removed.
    const rollbackBranch = async (): Promise<void> => {
      if (branchPreExisted) return;
      try {
        const res = await deleteBranchIfUnused(branch);
        console.warn(`[MC] launch rollback for job "${args.name}": ${res.reason}`);
      } catch {
        // Best-effort cleanup
      }
    };
    try {
      worktreePath = await createWorktree({
        branch,
        postCreate,
        startPoint: args.baseBranch,
      });
    } catch (error) {
      throw new Error(
        `Failed to create worktree for branch "${branch}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 5. Handle OMO modes (copy plans if needed).
    // OMO presence already validated in pre-flight (3b) — never create-then-remove.
    if (mode === 'plan' || mode === 'ralph' || mode === 'ulw') {
      try {
        const sourcePlansPath = './.sisyphus/plans';
        const targetPlansPath = `${worktreePath}/.sisyphus/plans`;
        await copyPlansToWorktree(sourcePlansPath, targetPlansPath);
      } catch (error) {
        // Best-effort but visible: plans might not exist — warn, never silent.
        console.warn(
          `[MC] copyPlansToWorktree best-effort failed for "${args.name}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // 6. Branch: serve mode vs TUI mode.
    // Serve is the default: only an explicit `useServeMode: false` opts out
    // to legacy TUI (which cannot pin a model). An absent key ({}) serves.
    const useServeMode = config.useServeMode !== false;
    let allocatedPort: number | undefined;
    let serverUrl: string | undefined;
    let remoteSessionId: string | undefined;
    let modelRequested: { providerID: string; id: string; variant?: string } | undefined;
    let modelObserved: { providerID: string; id: string; variant?: string } | undefined;

    if (useServeMode) {
      // === SERVE MODE ===
      // Allocate port
      try {
        const activeJobs = await getRunningJobs();
        allocatedPort = await allocatePort(config, activeJobs);
      } catch (error) {
        try {
          await removeWorktree(worktreePath, true);
        } catch {
          // Best-effort cleanup
        }
        await rollbackBranch();
        throw new Error(
          `Failed to allocate port: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      serverUrl = `http://127.0.0.1:${allocatedPort}`;

      // Write serve launcher script
      let launcherPath: string;
      try {
        launcherPath = await writeServeLauncherScript(
          worktreePath,
          allocatedPort,
          config.serverPassword,
        );
      } catch (error) {
        await releasePort(allocatedPort).catch(() => {});
        try {
          await removeWorktree(worktreePath, true);
        } catch {
          // Best-effort cleanup
        }
        await rollbackBranch();
        throw new Error(
          `Failed to write serve launcher: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Create tmux session/window
      const initialCommand = `bash ${quoteShellPath(launcherPath)}`;
      try {
        if (placement === 'session') {
          await createSession({
            name: tmuxSessionName,
            workdir: worktreePath,
            command: initialCommand,
          });
        } else {
          const currentSession = getCurrentSession()!;
          await createWindow({
            session: currentSession,
            name: sanitizedName,
            workdir: worktreePath,
            command: initialCommand,
          });
        }
      } catch (error) {
        await releasePort(allocatedPort).catch(() => {});
        cleanupLauncherScript(worktreePath, 0);
        try {
          await removeWorktree(worktreePath, true);
        } catch {
          // Best-effort cleanup
        }
        await rollbackBranch();
        throw new Error(
          `Failed to create tmux ${placement}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Set up pane-died hook
      try {
        const hookCommand = `run-shell "echo '${jobId}' >> .mission-control/completed-jobs.log"`;
        await setPaneDiedHook(tmuxTarget, hookCommand);
      } catch {
        // Non-fatal: pane-died hook is supplementary; polling is primary
      }

      cleanupLauncherScript(worktreePath);

      // Wait for the 2.x /api surface, create the session with the pinned
      // model triple, and deliver the prompt. The legacy unprefixed SDK is
      // not served by 2.x (session.create answered `{}`).
      // Canonical path: launchWorkerViaServe (sdk-client) — same POST+prompt
      // the integrador reuses for the autonomous launcher (orchestrator.ts).
      try {
        const client = await v2WaitForServer(allocatedPort, {
          password: config.serverPassword,
        });
        const fullPrompt = buildFullPrompt({
          prompt: args.prompt,
          mode,
          planFile: args.planFile,
          autoCommit: config.autoCommit,
        });
        const modelInfo = getCurrentModelInfo(context?.sessionID);
        // No pin, no worker: running under an unknown server default (or a
        // silent TUI fallback) is worse than failing here with a name.
        if (!modelInfo) {
          throw new Error(
            '[MC] serve mode requires a pinned model, none tracked for this session — ' +
              'set it via the model tracker (or coordinator snapshot) instead of running unpinned.',
          );
        }
        // R03: the full triple (variant included) is pinned and verified
        // back via echo/GET — a silent server default throws instead of
        // running under the wrong model.
        const worker = await launchWorkerViaServe(client, {
          worktree: worktreePath,
          prompt: fullPrompt,
          model: {
            providerID: modelInfo.providerID,
            id: modelInfo.modelID,
            ...(modelInfo.variant ? { variant: modelInfo.variant } : {}),
          },
          // Allow-inside ruleset: reads/writes/shell within the worktree
          // never ask; anything outside stays under the default policy.
          // Title + agent ride the session profile (echoed back by serve,
          // revalidated on 2.2.5).
          profile: {
            permissions: buildWorktreePermissions(worktreePath),
            title: args.name,
            ...(args.agent ? { agent: args.agent } : {}),
          },
          tmuxTarget,
        });
        remoteSessionId = worker.sessionId;
        modelRequested = worker.requestedModel;
        modelObserved = worker.observedModel;
      } catch (error) {
        await releasePort(allocatedPort).catch(() => {});
        try {
          if (placement === 'session') {
            await killSession(tmuxTarget);
          } else {
            const [session, window] = tmuxTarget.split(':');
            if (session && window) {
              await killWindow(session, window);
            }
          }
        } catch {
          // Best-effort tmux cleanup
        }
        try {
          await removeWorktree(worktreePath, true);
        } catch {
          // Best-effort cleanup
        }
        await rollbackBranch();
        throw new Error(
          `Failed to start serve session: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      // === TUI MODE (existing behavior) ===
      let promptFilePath: string | undefined;
      let launcherPath: string | undefined;
      try {
        const fullPrompt = buildFullPrompt({
          prompt: args.prompt,
          mode,
          planFile: args.planFile,
          autoCommit: config.autoCommit,
        });
        promptFilePath = await writePromptFile(worktreePath, fullPrompt);
        // TUI root cannot apply a model pin (no -m/--model on the 2.2.5 root
        // either — rejected with exit 1, revalidated natively): pass
        // the tracked string through unchanged — writeLauncherScript records
        // it as NOT pinned. Serve mode is the pinned path. Explicit opt-out
        // only (`useServeMode: false`): this branch is never silent.
        console.warn(
          `[MC] TUI launcher (unpinned model): ${describeTuiModelPin(getCurrentModel(context?.sessionID)).requested ?? 'none tracked'} — ${TUI_MODEL_BLOCKADE}`,
        );
        const model = getCurrentModel(context?.sessionID);
        launcherPath = await writeLauncherScript(worktreePath, promptFilePath, model);
      } catch (error) {
        if (promptFilePath) {
          cleanupPromptFile(promptFilePath, 0);
        }
        try {
          await removeWorktree(worktreePath, true);
        } catch {
          // Best-effort cleanup
        }
        await rollbackBranch();
        throw new Error(
          `Failed to write launch files: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const initialCommand = `bash ${quoteShellPath(launcherPath)}`;
      try {
        if (placement === 'session') {
          await createSession({
            name: tmuxSessionName,
            workdir: worktreePath,
            command: initialCommand,
          });
        } else {
          const currentSession = getCurrentSession()!;
          await createWindow({
            session: currentSession,
            name: sanitizedName,
            workdir: worktreePath,
            command: initialCommand,
          });
        }
      } catch (error) {
        cleanupPromptFile(promptFilePath!, 0);
        cleanupLauncherScript(worktreePath, 0);
        try {
          await removeWorktree(worktreePath, true);
        } catch {
          // Best-effort cleanup
        }
        await rollbackBranch();
        throw new Error(
          `Failed to create tmux ${placement}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      try {
        const hookCommand = `run-shell "echo '${jobId}' >> .mission-control/completed-jobs.log"`;
        await setPaneDiedHook(tmuxTarget, hookCommand);
      } catch {
        // Non-fatal: pane-died hook is supplementary; polling is primary
      }

      cleanupPromptFile(promptFilePath!);
      cleanupLauncherScript(worktreePath);

      if (mode !== 'vanilla') {
        try {
          await sleep(2000);
          switch (mode) {
            case 'plan':
              await sendKeys(tmuxTarget, '/start-work');
              await sendKeys(tmuxTarget, 'Enter');
              break;
            case 'ralph':
              await sendKeys(tmuxTarget, '/ralph-loop');
              await sendKeys(tmuxTarget, 'Enter');
              break;
            case 'ulw':
              await sendKeys(tmuxTarget, '/ulw-loop');
              await sendKeys(tmuxTarget, 'Enter');
              break;
          }
        } catch (error) {
          // Best-effort but visible: OMO command delivery failure is not silent.
          console.warn(
            `[MC] OMO sendKeys best-effort failed for "${args.name}" (mode ${mode}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    // 7. Create and persist job
    const job: Job = {
      id: jobId,
      name: args.name,
      worktreePath,
      branch,
      baseBranch: args.baseBranch,
      tmuxTarget,
      placement,
      status: 'running',
      prompt: args.prompt,
      mode,
      planFile: args.planFile,
      createdAt: new Date().toISOString(),
      launchSessionID: context?.sessionID,
      port: allocatedPort,
      serverUrl,
      remoteSessionID: remoteSessionId,
      ...(modelRequested ? { modelRequested: { ...modelRequested } } : {}),
      ...(modelObserved ? { modelObserved: { ...modelObserved } } : {}),
    };

    await addJob(job);

    // 8. Return job info
    const infoLines = [
      `Job "${args.name}" launched successfully.`,
      '',
      `  ID:        ${jobId}`,
      `  Branch:    ${branch}`,
      ...(args.baseBranch ? [`  Base:      ${args.baseBranch}`] : []),
      `  Worktree:  ${worktreePath}`,
      `  tmux:      ${tmuxTarget}`,
      `  Placement: ${placement}`,
      `  Mode:      ${mode}`,
    ];

    if (allocatedPort) {
      infoLines.push(`  Port:      ${allocatedPort}`);
      infoLines.push(`  Server:    ${serverUrl}`);
    }

    infoLines.push('');
    infoLines.push(
      placement === 'session'
        ? `Attach with: tmux attach -t ${tmuxSessionName}`
        : `Switch with: tmux select-window -t ${tmuxTarget}`,
    );

    return infoLines.join('\n');
  },
});
