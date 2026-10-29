import type { Plugin } from '@opencode-ai/plugin';
import { z } from 'zod';
import { getSharedMonitor, setSharedNotifyCallback, getSharedNotifyCallback, setSharedOrchestrator } from './lib/orchestrator-singleton';
import { getCompactionContext, getJobCompactionContext } from './hooks/compaction';
import { shouldShowAutoStatus, getAutoStatusMessage } from './hooks/auto-status';
import { setupNotifications, hasAnnotation, resetSessionTitle, isTitleResetSuppressed, ensureMCPrefix } from './hooks/notifications';
import { registerCommands, createCommandHandler } from './commands';
import { isTmuxAvailable } from './lib/tmux';
import { loadPlan } from './lib/plan-state';
import { Orchestrator } from './lib/orchestrator';
import { loadConfig } from './lib/config';
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

export const MissionControl: Plugin = async ({ client }) => {
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
    await client.config?.get?.()?.then((result: any) => {
      const config = result?.data;
      if (config?.model) {
        setConfigFallbackModel(config.model);
      }
    })?.catch(() => {});
  } catch {
    // V2 setup shim has no config surface: fallback stays unset, no crash.
  }

  if (!isJobAgent) {
    loadPlan().then(async (plan) => {
      if (plan && (plan.status === 'running' || plan.status === 'paused')) {
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
      : { mc_launch, mc_jobs, mc_status, mc_diff, mc_pr, mc_merge, mc_sync, mc_cleanup, mc_kill, mc_attach, mc_capture, mc_plan, mc_plan_status, mc_plan_cancel, mc_plan_approve, mc_report, mc_report_final, mc_overview, mc_answer, mc_job_pause, mc_job_resume },
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
  execute: (args: any) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
};

function v1ToolToV2(name: string, v1: any): V2ToolDef {
  let input: unknown = { type: 'object', properties: {}, additionalProperties: true };
  try {
    if (v1?.args && typeof v1.args === 'object') {
      input = z.toJSONSchema(z.object(v1.args));
    }
  } catch {
    // Fallback to permissive schema: V1 validation still runs inside execute.
  }
  return {
    name,
    description: v1?.description ?? name,
    input,
    async execute(args: any) {
      const text = await v1.execute(args, {
        sessionID: '',
        messageID: '',
        agent: '',
        directory: process.cwd(),
        worktree: process.cwd(),
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {},
      });
      return { content: [{ type: 'text' as const, text: String(text ?? '') }] };
    },
  };
}

export default {
  id: 'opencode-mission-control',
  async setup(ctx: any) {
    const directory =
      ctx?.location?.directory ??
      ctx?.location?.project?.directory ??
      ctx?.directory ??
      process.cwd();
    // Shim V1 client over V2 ctx.session (V2 has no ctx.client; session
    // arg shapes differ, so adapt defensively — failures degrade to
    // undefined, never crash setup).
    const v2session = ctx?.session;
    const client = (ctx as any)?.client ?? {
      session: {
        list: async (...a: any[]) => {
          try {
            return await v2session?.list?.(...a);
          } catch {
            return [];
          }
        },
        get: async (arg: any) => {
          try {
            if (arg?.path?.id && typeof v2session?.get === 'function') {
              return await v2session.get({ sessionID: arg.path.id });
            }
            return await v2session?.get?.(arg);
          } catch {
            return undefined;
          }
        },
        prompt: async (arg: any) => {
          try {
            return await v2session?.prompt?.(arg);
          } catch {}
        },
      },
      config: { get: async () => ({ data: {} }) },
      tui: { showToast: async () => {} },
    };
    // Reuse V1 init (monitor, notifications, plan resume) as single source.
    const v1 = await MissionControl({ client, project: ctx?.project, directory, worktree: directory, serverUrl: undefined, $: undefined } as any);
    const v1Tools = (v1 as any).tool ?? {};
    const v2Tools = Object.entries(v1Tools).map(([name, v1Tool]) => v1ToolToV2(name, v1Tool));

    if (typeof ctx?.tool?.transform === 'function') {
      await ctx.tool.transform((editor: any) => {
        for (const t of v2Tools) editor.add(t);
      });
    }

    const controller = new AbortController();
    const v1Event = (v1 as any).event;
    if (typeof ctx?.event?.subscribe === 'function' && typeof v1Event === 'function') {
      (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            try {
              await v1Event({ event });
            } catch {}
          }
        } catch {}
      })().catch(() => {});
    }

    const v1ToolBefore = (v1 as any)['tool.execute.before'];
    if (typeof ctx?.tool?.hook === 'function' && typeof v1ToolBefore === 'function') {
      await ctx.tool.hook('execute.before', async (event: any) => {
        try {
          await v1ToolBefore({ tool: event?.tool, sessionID: event?.sessionID, callID: event?.id ?? event?.callID });
        } catch {}
      });
    }

    const v1Compacting = (v1 as any)['experimental.session.compacting'];
    if (typeof ctx?.session?.hook === 'function' && typeof v1Compacting === 'function') {
      await ctx.session.hook('compaction', async (event: any) => {
        const out = { context: [] as string[] };
        try {
          await v1Compacting({ sessionID: event?.sessionID }, out);
        } catch {}
        if (Array.isArray(event?.system)) {
          for (const text of out.context) event.system.push({ type: 'text', text });
        }
      });
    }

    const v1ChatMessage = (v1 as any)['chat.message'];
    if (typeof ctx?.session?.hook === 'function' && typeof v1ChatMessage === 'function') {
      await ctx.session.hook('prompt', async (event: any) => {
        try {
          if (event?.prompt && typeof event.prompt.text === 'string') {
            const part = { type: 'text', text: event.prompt.text };
            await v1ChatMessage({ sessionID: event?.sessionID, model: event?.model }, { message: undefined, parts: [part] });
            event.prompt.text = (part as any).text;
          } else {
            await v1ChatMessage({ sessionID: event?.sessionID, model: event?.model }, { message: undefined, parts: [] });
          }
        } catch {}
      });
    }

    return () => controller.abort();
  },
};
