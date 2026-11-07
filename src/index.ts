import type { Plugin } from '@opencode-ai/plugin';
import { z } from 'zod';
import { getSharedMonitor, setSharedNotifyCallback, getSharedNotifyCallback, setSharedOrchestrator } from './lib/orchestrator-singleton';
import { getCompactionContext, getJobCompactionContext } from './hooks/compaction';
import { shouldShowAutoStatus, getAutoStatusMessage } from './hooks/auto-status';
import { setupNotifications, hasAnnotation, resetSessionTitle, isTitleResetSuppressed, ensureMCPrefix } from './hooks/notifications';
import { registerCommands, createCommandHandler } from './commands';
import { isTmuxAvailable } from './lib/tmux';
import { assertHardenedRealEntry } from './lib/monitor';
import { loadPlan } from './lib/plan-state';
import { Orchestrator } from './lib/orchestrator';
import { loadConfig, assertPluginDistReady } from './lib/config';
import { setCurrentModel, setConfigFallbackModel } from './lib/model-tracker';
import { isInManagedWorktree } from './lib/worktree';
import { mc_launch } from './tools/launch';
import { mc_jobs } from './tools/jobs';
import { mc_status } from './tools/status';
import { mc_diff } from './tools/diff';
import { mc_pr } from './tools/pr';
import { mc_merge } from './tools/merge';
import { mc_sync } from './tools/sync';
import { mc_cleanup } from './tools/cleanup';
import { mc_kill } from './tools/kill';
import { mc_attach } from './tools/attach';
import { mc_capture } from './tools/capture';
import { mc_plan } from './tools/plan';
import { mc_plan_status } from './tools/plan-status';
import { mc_plan_cancel } from './tools/plan-cancel';
import { mc_plan_approve } from './tools/plan-approve';
import { mc_report } from './tools/report';
import { mc_report_final } from './tools/report';
import { mc_overview } from './tools/overview';
import { mc_answer } from './tools/answer';
import { mc_job_pause } from './tools/job-pause';
import { mc_job_resume } from './tools/job-resume';

interface SessionWithID {
  id?: string;
}

function isValidSessionID(id: string): boolean {
  return id.startsWith('ses');
}

function extractSessionIDFromEvent(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') {
    return undefined;
  }

  const candidate = event as {
    sessionID?: string;
    sessionId?: string;
    session?: SessionWithID;
    properties?: {
      sessionID?: string;
      info?: SessionWithID;
    };
  };

  if (typeof candidate.sessionID === 'string' && isValidSessionID(candidate.sessionID)) {
    return candidate.sessionID;
  }

  if (typeof candidate.sessionId === 'string' && isValidSessionID(candidate.sessionId)) {
    return candidate.sessionId;
  }

  if (candidate.properties) {
    if (typeof candidate.properties.sessionID === 'string' && isValidSessionID(candidate.properties.sessionID)) {
      return candidate.properties.sessionID;
    }
    if (candidate.properties.info?.id && typeof candidate.properties.info.id === 'string' && isValidSessionID(candidate.properties.info.id)) {
      return candidate.properties.info.id;
    }
  }

  if (
    candidate.session &&
    typeof candidate.session.id === 'string' &&
    isValidSessionID(candidate.session.id)
  ) {
    return candidate.session.id;
  }

  return undefined;
}

function extractSessionIDFromListResult(listResult: unknown): string | undefined {
  const sources: unknown[] = [];

  if (Array.isArray(listResult)) {
    sources.push(...listResult);
  } else if (listResult && typeof listResult === 'object') {
    const container = listResult as {
      sessions?: unknown;
      items?: unknown;
      data?: unknown;
    };

    if (Array.isArray(container.sessions)) {
      sources.push(...container.sessions);
    }
    if (Array.isArray(container.items)) {
      sources.push(...container.items);
    }
    if (Array.isArray(container.data)) {
      sources.push(...container.data);
    }
  }

  for (const source of sources) {
    if (!source || typeof source !== 'object') {
      continue;
    }
    const session = source as SessionWithID;
    if (typeof session.id === 'string' && isValidSessionID(session.id)) {
      return session.id;
    }
  }

  return undefined;
}

let tmuxAvailable = false;

/* ------------------------------------------------------------------ */
/* R6b hardened plugin entries (same rigor as CLI, single source).     */
/* Autonomous missions must never lose fencing/external-review by      */
/* inheriting NODE_ENV=test/VITEST=true from the host. Driving tools  */
/* (mc_launch = start, mc_plan/mc_plan_approve = approve,              */
/* mc_job_resume = resume) refuse fail-closed without the explicit,    */
/* auditable `--allow-test-env` argv signal (inherited                 */
/* MC_ALLOW_TEST_ENV=1 alone is refused). Read-only tools              */
/* (mc_status/mc_jobs/mc_diff/mc_plan_status/mc_overview/...) stay     */
/* available; other job controls go through conductor-lease checks     */
/* that fail closed in prod (R2) and never consult the test env.       */
/* Library call paths (direct tool imports in unit tests) stay ungated */
/* — only the plugin-registered wrappers below refuse.                 */
/* ------------------------------------------------------------------ */

const DRIVING_PLUGIN_TOOLS = new Set(['mc_launch', 'mc_plan', 'mc_plan_approve', 'mc_plan_cancel', 'mc_job_resume']);

function withHardenedTestEnvGate<T extends { execute: (...a: never[]) => Promise<unknown> }>(
  name: string,
  v1Tool: T,
): T {
  if (!DRIVING_PLUGIN_TOOLS.has(name)) return v1Tool;
  const original = (v1Tool as { execute: (...a: never[]) => Promise<unknown> }).execute.bind(v1Tool);
  return {
    ...(v1Tool as Record<string, unknown>),
    async execute(...args: never[]) {
      assertHardenedRealEntry(`plugin ${name}`);
      return await original(...args);
    },
  } as T;
}

export const MissionControl: Plugin = async ({ client }) => {
  // Fail-fast: dist ausente ou desatualizado → erro com instrução
  // reproduzível, nunca missão que termina sem o recurso.
  assertPluginDistReady();
  const cwd = process.cwd();
  const worktreeInfo = await isInManagedWorktree(cwd);
  const isJobAgent = worktreeInfo.isManaged;

  tmuxAvailable = await isTmuxAvailable();
  if (!tmuxAvailable) {
    console.warn('[Mission Control] tmux is not installed or not in PATH. Job launching will be unavailable.');
  }

  const monitor = getSharedMonitor();
  let activeSessionID: string | undefined;

  const getActiveSessionID = async (): Promise<string | undefined> => {
    if (activeSessionID) {
      return activeSessionID;
    }

    try {
      const listResult = await client.session.list();
      activeSessionID = extractSessionIDFromListResult(listResult);
      return activeSessionID;
    } catch {
      return undefined;
    }
  };

  // Detect if we're a subagent spawned by another OpenCode session
  let _isSubagentCached: boolean | null = null;
  const isSubagent = async (): Promise<boolean> => {
    if (_isSubagentCached !== null) return _isSubagentCached;
    try {
      const sessionID = await getActiveSessionID();
      if (!sessionID) {
        _isSubagentCached = false;
        return false;
      }
      const session = await client.session.get({ path: { id: sessionID } });
      const data = (session as any)?.data ?? session;
      _isSubagentCached = !!(data?.parentID || data?.parentId);
      return _isSubagentCached;
    } catch {
      _isSubagentCached = false;
      return false;
    }
  };

  if (!isJobAgent) {
    setupNotifications({
      client,
      monitor,
      getActiveSessionID,
      isSubagent,
    });
  }

  let notifyPending: Promise<void> = Promise.resolve();
  if (!isJobAgent) {
    setSharedNotifyCallback((message: string, targetSessionID?: string) => {
      notifyPending = notifyPending.then(async () => {
        const sessionID = targetSessionID ?? await getActiveSessionID();
        if (!sessionID || !sessionID.startsWith('ses')) return;
        await client.session.prompt({
          path: { id: sessionID },
          body: {
            noReply: true,
            parts: [{ type: 'text' as const, text: message }],
          },
        }).catch(() => {});
      }).catch(() => {});
    });
  }

  if (!isJobAgent) {
    monitor.start();
  }

  try {
    await client.config?.get?.()?.then((result: { data?: { model?: string } }) => {
      const config = result?.data;
      if (config?.model) {
        setConfigFallbackModel(config.model);
      }
    })?.catch((error: unknown) => {
      console.warn('[Mission Control] config fallback unavailable:', error instanceof Error ? error.message : String(error));
    });
  } catch (error) {
    // V2 host has no config surface: fallback stays unset (explicit warn, no crash).
    console.warn('[Mission Control] config surface missing:', error instanceof Error ? error.message : String(error));
  }

  if (!isJobAgent) {
    loadPlan().then(async (plan) => {
      if (plan && (plan.status === 'running' || plan.status === 'paused')) {
        // R6b: auto-resume drives the conductor (fencing + reviewer).
        // Refuse fail-closed on inherited test env; explicit flag allows + audits.
        try {
          assertHardenedRealEntry('plugin auto-resume');
        } catch (error) {
          console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        const config = await loadConfig();
        const orchestrator = new Orchestrator(monitor, config, { notify: getSharedNotifyCallback() ?? undefined });
        setSharedOrchestrator(orchestrator);
        await orchestrator.resumePlan();
      }
    }).catch(() => {});
  }

  return {
    config: async (configInput: any) => {
      if (!isJobAgent) {
        registerCommands(configInput);
      }
    },
    'command.execute.before': (input: { command: string; sessionID: string; arguments: string }, output: { parts: unknown[] }) => {
      if (isValidSessionID(input.sessionID)) {
        activeSessionID = input.sessionID;
        if (hasAnnotation(input.sessionID) && !isTitleResetSuppressed(input.sessionID)) {
          resetSessionTitle(client, input.sessionID).catch(() => {});
        }
      }
      return createCommandHandler(client)(input, output);
    },
    'tool.execute.before': async (input: { tool: string; sessionID: string; callID: string }) => {
      if (input.sessionID && isValidSessionID(input.sessionID)) {
        activeSessionID = input.sessionID;
        if (hasAnnotation(input.sessionID) && !isTitleResetSuppressed(input.sessionID)) {
          resetSessionTitle(client, input.sessionID).catch(() => {});
        }
      }
      if (input.tool?.startsWith('mc_')) {
        const sessionID = input.sessionID ?? await getActiveSessionID();
        ensureMCPrefix(client, sessionID).catch(() => {});
      }
    },
    'chat.message': async (input) => {
      if (input.sessionID && isValidSessionID(input.sessionID)) {
        activeSessionID = input.sessionID;
        if (hasAnnotation(input.sessionID) && !isTitleResetSuppressed(input.sessionID)) {
          resetSessionTitle(client, input.sessionID).catch(() => {});
        }
      }
      if (input.model) {
        setCurrentModel(input.model, input.sessionID);
      }
    },
    'chat.params': async (input) => {
      if (input.sessionID && isValidSessionID(input.sessionID)) {
        activeSessionID = input.sessionID;
      }
      // chat.params fires for background LLM calls too (title gen, summarization)
      // which use smaller models — do not track model here, chat.message is authoritative
    },
    tool: isJobAgent 
      ? { mc_report, mc_status } as any
      : {
          mc_launch: withHardenedTestEnvGate('mc_launch', mc_launch as never) as never,
          mc_jobs, mc_status, mc_diff, mc_pr, mc_merge, mc_sync, mc_cleanup, mc_kill, mc_attach, mc_capture,
          mc_plan: withHardenedTestEnvGate('mc_plan', mc_plan as never) as never,
          mc_plan_status,
          mc_plan_cancel: withHardenedTestEnvGate('mc_plan_cancel', mc_plan_cancel as never) as never,
          mc_plan_approve: withHardenedTestEnvGate('mc_plan_approve', mc_plan_approve as never) as never,
          mc_report, mc_report_final, mc_overview, mc_answer, mc_job_pause,
          mc_job_resume: withHardenedTestEnvGate('mc_job_resume', mc_job_resume as never) as never,
        } as any,
    event: async ({ event }) => {
      const sessionID = extractSessionIDFromEvent(event);
      if (sessionID) {
        activeSessionID = sessionID;
      }

      if (event.type === 'message.updated') {
        const messageEvent = event as {
          properties?: {
            info?: {
              role?: string;
              model?: { providerID: string; modelID: string };
              providerID?: string;
              modelID?: string;
            };
          };
        };
        const info = messageEvent.properties?.info;
        if (info?.model) {
          setCurrentModel(info.model, sessionID);
        } else if (info?.providerID && info?.modelID) {
          setCurrentModel({ providerID: info.providerID, modelID: info.modelID }, sessionID);
        }
      }

      if (event.type === 'session.idle') {
        const shouldShow = await shouldShowAutoStatus();
        if (shouldShow) {
          const message = await getAutoStatusMessage();
          if (message) {
            await client.tui?.showToast?.({
              body: {
                title: 'Mission Control',
                message,
                variant: 'info',
                duration: 8000,
              },
            })?.catch(() => {});
          }
        }
      }
    },
    // SDK uses proxies on hook output objects — must use in-place mutation
    // (push/splice). Direct reassignment (e.g. output.context = [...]) is
    // silently ignored. See: opencode Plugin.trigger() proxy semantics.
    'experimental.session.compacting': async (_input, output) => {
      output.context.push(await (isJobAgent ? getJobCompactionContext() : getCompactionContext()));
    },
  };
};

/**
 * V2 plugin definition for OpenCode 2.1.4 (see F10).
 * V1 (`@opencode-ai/plugin` function returning Hooks) no longer loads on the
 * 2.x host: it rejects with `Plugin must export a default definition with an
 * id and an effect or setup function (Expected object at ["default"])`.
 * This adapter reuses the V1 `MissionControl` implementation (single source
 * of truth) and maps it onto the V2 API (`ctx.tool.transform/hook`,
 * `ctx.event.subscribe`, `ctx.session.hook`), following the official
 * migrate-v1 pattern (event → subscribe, chat.message → session prompt,
 * compacting → session compaction).
 */
type V2ToolDef = {
  name: string;
  description: string;
  input: unknown;
  execute: (args: unknown, callCtx?: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
};

type V2Host = {
  directory: string;
  worktree: string;
  signal: AbortSignal;
  getActiveSessionID?: () => string | undefined;
};

function pickText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readLocationDir(ctx: unknown): string | undefined {
  if (!ctx || typeof ctx !== 'object') return undefined;
  const root = ctx as {
    location?: { directory?: unknown; worktree?: unknown; project?: { directory?: unknown } };
    directory?: unknown;
    project?: { directory?: unknown };
  };
  return (
    pickText(root.location?.directory) ??
    pickText(root.directory) ??
    pickText(root.project?.directory) ??
    pickText(root.location?.project?.directory)
  );
}

/** Host project directory: ctx.location.directory with fallbacks, else cwd. */
export function resolveV2Directory(ctx: unknown): string {
  return readLocationDir(ctx) ?? process.cwd();
}

/** Host worktree root: ctx.location.worktree when present, else directory. */
export function resolveV2Worktree(ctx: unknown, directory: string): string {
  if (ctx && typeof ctx === 'object') {
    const root = ctx as { location?: { worktree?: unknown }; worktree?: unknown };
    const w = pickText(root.location?.worktree) ?? pickText(root.worktree);
    if (w) return w;
  }
  return directory;
}

function readCallField(callCtx: unknown, keys: string[]): string | undefined {
  if (!callCtx || typeof callCtx !== 'object') return undefined;
  const record = callCtx as Record<string, unknown>;
  for (const key of keys) {
    const value = pickText(record[key]);
    if (value) return value;
    if (key === 'directory' || key === 'worktree') {
      const nested = record['location'];
      if (nested && typeof nested === 'object') {
        const nestedValue = pickText((nested as Record<string, unknown>)[key === 'directory' ? 'directory' : 'worktree']);
        if (nestedValue) return nestedValue;
      }
    }
  }
  return undefined;
}

function readCallSignal(callCtx: unknown): AbortSignal | undefined {
  if (!callCtx || typeof callCtx !== 'object') return undefined;
  const record = callCtx as Record<string, unknown>;
  const candidate = record['abort'] ?? record['signal'];
  return candidate instanceof AbortSignal ? candidate : undefined;
}

function combineSignals(primary: AbortSignal, parent: AbortSignal): AbortSignal {
  const anyCombine = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyCombine === 'function') {
    try {
      return anyCombine.call(AbortSignal, [primary, parent]);
    } catch {
      return primary;
    }
  }
  return primary;
}

/**
 * Build the V1 ToolContext for one V2 tool call from the per-call host
 * context, falling back to setup-time host state (never a fixed stub).
 * Session tracks the live host session: explicit call value first, then the
 * last session observed on the host, then '' (V1 tools treat '' as unknown
 * and use their own fallback chain).
 */
export function buildV1ToolContext(
  callCtx: unknown,
  host: V2Host,
): import('@opencode-ai/plugin').ToolContext {
  const callSignal = readCallSignal(callCtx);
  const sessionID =
    readCallField(callCtx, ['sessionID', 'sessionId']) ?? host.getActiveSessionID?.() ?? '';
  return {
    sessionID,
    messageID: readCallField(callCtx, ['messageID', 'messageId']) ?? '',
    agent: readCallField(callCtx, ['agent']) ?? '',
    directory: readCallField(callCtx, ['directory']) ?? host.directory,
    worktree: readCallField(callCtx, ['worktree']) ?? host.worktree,
    abort: callSignal ? combineSignals(callSignal, host.signal) : host.signal,
    metadata: () => {},
    ask: async () => {},
  };
}

export function v1ToolToV2(
  name: string,
  v1: { description?: string; args?: Record<string, unknown>; execute: (args: never, ctx: import('@opencode-ai/plugin').ToolContext) => Promise<string> },
  host: V2Host,
): V2ToolDef {
  let input: unknown = { type: 'object', properties: {}, additionalProperties: true };
  try {
    const args = (v1 as { args?: Record<string, unknown> }).args;
    if (args && typeof args === 'object') {
      input = z.toJSONSchema(z.object(args as Record<string, import('zod').ZodTypeAny>));
    }
  } catch {
    // Fallback to permissive schema: V1 validation still runs inside execute.
  }
  const description = (v1 as { description?: string }).description ?? name;
  const executeV1 = (v1 as { execute: (args: never, ctx: import('@opencode-ai/plugin').ToolContext) => Promise<string> }).execute.bind(v1);
  return {
    name,
    description,
    input,
    async execute(args: unknown, callCtx?: unknown) {
      const toolCtx = buildV1ToolContext(callCtx, host);
      const text = await executeV1(args as never, toolCtx);
      return { content: [{ type: 'text' as const, text: String(text ?? '') }] };
    },
  };
}

export default {
  id: 'opencode-mission-control',
  async setup(ctx: any) {
    const directory = resolveV2Directory(ctx);
    const worktree = resolveV2Worktree(ctx, directory);
    // Live host session observed on V2 events/hooks/calls (per-call first,
    // then last observed — never a fixed stub).
    let v2ActiveSessionID: string | undefined;
    const trackSessionID = (value: unknown) => {
      if (typeof value === 'string' && isValidSessionID(value)) {
        v2ActiveSessionID = value;
      }
    };
    // Shim V1 client over V2 ctx.session (V2 has no ctx.client; session arg
    // shapes differ, so adapt shapes only — failures propagate, never
    // resolve to empty defaults. Missing surfaces throw explicitly.).
    const v2session = ctx?.session;
    const client = ctx?.client ?? {
      session: {
        list: async (...a: unknown[]) => {
          if (typeof v2session?.list !== 'function') {
            throw new Error('[MC] V2 host: session.list unavailable');
          }
          return await v2session.list(...a);
        },
        get: async (arg: { path?: { id?: string } } & Record<string, unknown>) => {
          if (typeof v2session?.get !== 'function') {
            throw new Error('[MC] V2 host: session.get unavailable');
          }
          const id = arg?.path?.id;
          if (typeof id === 'string' && id.length > 0) {
            return await v2session.get({ sessionID: id });
          }
          return await v2session.get(arg);
        },
        prompt: async (arg: Record<string, unknown>) => {
          if (typeof v2session?.prompt !== 'function') {
            throw new Error('[MC] V2 host: session.prompt unavailable');
          }
          return await v2session.prompt(arg);
        },
      },
      config: {
        get: async () => {
          throw new Error('[MC] V2 host: config.get unavailable (no config surface on V2 ctx)');
        },
      },
      tui: {
        showToast: async () => {
          throw new Error('[MC] V2 host: tui.showToast unavailable (no tui surface on V2 ctx)');
        },
      },
    };
    // Reuse V1 init (monitor, notifications, plan resume) as single source.
    const v1 = await MissionControl({ client, project: ctx?.project, directory, worktree, serverUrl: undefined, $: undefined } as any);
    const v1Tools = (v1 as any).tool ?? {};
    const controller = new AbortController();
    const host: V2Host = {
      directory,
      worktree,
      signal: controller.signal,
      getActiveSessionID: () => v2ActiveSessionID,
    };
    const v2Tools = Object.entries(v1Tools).map(([name, v1Tool]) =>
      v1ToolToV2(name, v1Tool as { description?: string; args?: Record<string, unknown>; execute: (args: never, ctx: import('@opencode-ai/plugin').ToolContext) => Promise<string> }, host),
    );

    if (typeof ctx?.tool?.transform === 'function') {
      await ctx.tool.transform((editor: any) => {
        for (const t of v2Tools) editor.add(t);
      });
    }

    const v1Event = (v1 as any).event;
    if (typeof ctx?.event?.subscribe === 'function' && typeof v1Event === 'function') {
      (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            try {
              trackSessionID((event as { sessionID?: unknown })?.sessionID);
              await v1Event({ event });
            } catch (error) {
              console.warn('[MC] V2 event forward failed:', error instanceof Error ? error.message : String(error));
            }
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          console.warn('[MC] V2 event subscribe ended:', error instanceof Error ? error.message : String(error));
        }
      })().catch((error: unknown) => {
        console.warn('[MC] V2 event loop failed:', error instanceof Error ? error.message : String(error));
      });
    }

    const v1ToolBefore = (v1 as any)['tool.execute.before'];
    if (typeof ctx?.tool?.hook === 'function' && typeof v1ToolBefore === 'function') {
      await ctx.tool.hook('execute.before', async (event: any) => {
        trackSessionID(event?.sessionID);
        await v1ToolBefore({ tool: event?.tool, sessionID: event?.sessionID, callID: event?.id ?? event?.callID });
      });
    }

    const v1Compacting = (v1 as any)['experimental.session.compacting'];
    if (typeof ctx?.session?.hook === 'function' && typeof v1Compacting === 'function') {
      await ctx.session.hook('compaction', async (event: any) => {
        trackSessionID(event?.sessionID);
        const out = { context: [] as string[] };
        await v1Compacting({ sessionID: event?.sessionID }, out);
        if (Array.isArray(event?.system)) {
          for (const text of out.context) event.system.push({ type: 'text', text });
        }
      });
    }

    const v1ChatMessage = (v1 as any)['chat.message'];
    if (typeof ctx?.session?.hook === 'function' && typeof v1ChatMessage === 'function') {
      await ctx.session.hook('prompt', async (event: any) => {
        trackSessionID(event?.sessionID);
        if (event?.prompt && typeof event.prompt.text === 'string') {
          const part = { type: 'text', text: event.prompt.text };
          await v1ChatMessage({ sessionID: event?.sessionID, model: event?.model }, { message: undefined, parts: [part] });
          event.prompt.text = (part as any).text;
        } else {
          await v1ChatMessage({ sessionID: event?.sessionID, model: event?.model }, { message: undefined, parts: [] });
        }
      });
    }

    return () => controller.abort();
  },
};
