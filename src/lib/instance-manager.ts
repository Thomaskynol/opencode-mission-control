import {
  v2Background,
  v2CompactSession,
  v2CreateSession,
  v2ForkSession,
  v2Generate,
  v2GetSession,
  v2Interrupt,
  v2MoveSession,
  v2Prompt,
  v2Wait,
  type V2Client,
  type V2ModelRef,
  type V2PermissionRule,
  type V2SessionInfo,
} from './sdk-client.js';

/**
 * Pinned execution profile for one managed instance. The manager mounts
 * this exact profile on `session.create` (model triple + agent +
 * location.directory + permissions) and re-checks it against the live
 * session; anything that drifts pauses instead of silently continuing.
 */
export interface InstanceProfile {
  model: V2ModelRef;
  agent: string;
  directory: string;
  projectID?: string;
  permissions?: V2PermissionRule[];
  title?: string;
}

/** Live-session facts needed for the equivalence check. */
export interface V2SessionSnapshot {
  id: string;
  projectID: string;
  agent?: string;
  model?: V2ModelRef;
  location: { directory: string };
  permissions?: V2PermissionRule[];
}

export interface EquivalenceResult {
  equivalent: boolean;
  mismatches: string[];
}

function normalizeDirectory(dir: string): string {
  return dir.endsWith('/') && dir.length > 1 ? dir.slice(0, -1) : dir;
}

function sameRuleset(a: V2PermissionRule[] | undefined, b: V2PermissionRule[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/**
 * Compare the pinned profile against the live session. Variant is only
 * compared when the profile pins one; projectID/permissions only when
 * the profile sets them.
 */
export function assertProfileEquivalence(
  expected: InstanceProfile,
  actual: V2SessionSnapshot,
): EquivalenceResult {
  const mismatches: string[] = [];

  if (!actual.model) {
    mismatches.push('model: live session reports no model');
  } else {
    if (actual.model.providerID !== expected.model.providerID) {
      mismatches.push(
        `model.providerID: expected "${expected.model.providerID}", got "${actual.model.providerID}"`,
      );
    }
    if (actual.model.id !== expected.model.id) {
      mismatches.push(`model.id: expected "${expected.model.id}", got "${actual.model.id}"`);
    }
    if (expected.model.variant !== undefined && actual.model.variant !== expected.model.variant) {
      mismatches.push(
        `model.variant: expected "${expected.model.variant}", got "${actual.model.variant ?? '(unset)'}"`,
      );
    }
  }

  if (actual.agent !== undefined && actual.agent !== expected.agent) {
    mismatches.push(`agent: expected "${expected.agent}", got "${actual.agent}"`);
  } else if (actual.agent === undefined && expected.agent) {
    mismatches.push(`agent: expected "${expected.agent}", got "(unset)"`);
  }

  if (normalizeDirectory(actual.location.directory) !== normalizeDirectory(expected.directory)) {
    mismatches.push(
      `location.directory: expected "${expected.directory}", got "${actual.location.directory}"`,
    );
  }

  if (expected.projectID !== undefined && actual.projectID !== expected.projectID) {
    mismatches.push(`projectID: expected "${expected.projectID}", got "${actual.projectID}"`);
  }

  if (expected.permissions !== undefined && !sameRuleset(expected.permissions, actual.permissions)) {
    mismatches.push('permissions: live session ruleset differs from the pinned profile');
  }

  return { equivalent: mismatches.length === 0, mismatches };
}

export interface FallbackOutcome {
  action: 'pause';
  question: string;
  requested: V2ModelRef;
  available: V2ModelRef[];
  reason: string;
  /** Always undefined: the manager never swaps the model on its own. */
  swappedModel?: undefined;
}

/**
 * No silent fallback, ever. When the pinned model cannot be served, the
 * instance pauses and produces an operator question naming the requested
 * model and the candidates. The operator picks; the manager never does.
 */
export function resolveModelFallback(
  requested: V2ModelRef,
  available: V2ModelRef[],
  reason: string,
): FallbackOutcome {
  const wanted = `${requested.providerID}/${requested.id}${requested.variant ? ` (${requested.variant})` : ''}`;
  const options = available.length > 0
    ? available
        .map((m) => `${m.providerID}/${m.id}${m.variant ? ` (${m.variant})` : ''}`)
        .join(', ')
    : '(no alternatives reported)';
  return {
    action: 'pause',
    question:
      `Pinned model ${wanted} is not servable (${reason}). ` +
      `Instance paused. Alternatives seen: ${options}. ` +
      `Reply with the exact model to use, or abort the instance.`,
    requested: { ...requested },
    available: available.map((m) => ({ ...m })),
    reason,
    swappedModel: undefined,
  };
}

export const INSTANCE_DEPTH_ENV = 'MC_INSTANCE_DEPTH';

/** Anti-recursion: a worker must never start another full managed run. */
export function readInstanceDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[INSTANCE_DEPTH_ENV];
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
}

export function evaluateDepthGuard(depth: number, maxDepth = 1): void {
  if (depth >= maxDepth) {
    throw new Error(
      `Nested managed run blocked by recursion guard (depth ${depth} >= max ${maxDepth}): ` +
        `a worker instance must not start another full product execution.`,
    );
  }
}

/** Operations against the 2.1.4 API; injectable for tests. */
export interface InstanceOps {
  create: (profile: InstanceProfile) => Promise<{ sessionID: string }>;
  get: (sessionID: string) => Promise<V2SessionSnapshot>;
  interrupt: (sessionID: string) => Promise<void>;
  wait: (sessionID: string) => Promise<void>;
}

/** Wire the real 2.1.4 endpoints to InstanceOps for one serve instance. */
export function createLiveOps(client: V2Client): InstanceOps {
  return {
    create: async (profile: InstanceProfile) => {
      const info: V2SessionInfo = await v2CreateSession(client, {
        agent: profile.agent,
        model: profile.model,
        location: { directory: profile.directory },
        ...(profile.permissions !== undefined ? { permissions: profile.permissions } : {}),
        ...(profile.title !== undefined ? { title: profile.title } : {}),
      });
      return { sessionID: info.id };
    },
    get: (sessionID: string) => v2GetSession(client, sessionID),
    interrupt: async (sessionID: string) => {
      await v2Interrupt(client, sessionID);
    },
    wait: async (sessionID: string) => {
      await v2Wait(client, sessionID);
    },
  };
}

export interface LaunchResult {
  sessionID: string;
  equivalent: boolean;
  status: 'active' | 'paused';
  mismatches: string[];
  question?: string;
}

export interface InstanceManagerOptions {
  env?: NodeJS.ProcessEnv;
  maxDepth?: number;
}

/**
 * Owns one real serve session with a pinned profile. Launch asserts
 * equivalence before the session is handed out; drift pauses the
 * instance and asks the operator instead of continuing degraded.
 */
export class InstanceManager {
  private readonly profile: InstanceProfile;
  private readonly ops: InstanceOps;
  private readonly env: NodeJS.ProcessEnv;
  private readonly maxDepth: number;
  private sessionID?: string;

  constructor(profile: InstanceProfile, ops: InstanceOps, options: InstanceManagerOptions = {}) {
    this.profile = profile;
    this.ops = ops;
    this.env = options.env ?? process.env;
    this.maxDepth = options.maxDepth ?? 1;
  }

  async launch(): Promise<LaunchResult> {
    evaluateDepthGuard(readInstanceDepth(this.env), this.maxDepth);

    const { sessionID } = await this.ops.create(this.profile);
    this.sessionID = sessionID;

    const live = await this.ops.get(sessionID);
    const { equivalent, mismatches } = assertProfileEquivalence(this.profile, live);

    if (!equivalent) {
      return {
        sessionID,
        equivalent: false,
        status: 'paused',
        mismatches,
        question:
          `Session ${sessionID} drifted from its pinned profile and was paused before any work: ` +
          mismatches.join('; ') +
          '. Confirm the profile or abort the instance.',
      };
    }

    return { sessionID, equivalent: true, status: 'active', mismatches: [] };
  }

  private requireSession(): string {
    if (!this.sessionID) {
      throw new Error('Instance has not been launched yet');
    }
    return this.sessionID;
  }

  /** Pause: interrupt the agent loop. */
  async pause(): Promise<void> {
    await this.ops.interrupt(this.requireSession());
  }

  /** Resume: wait until the loop is idle again. */
  async resume(): Promise<void> {
    await this.ops.wait(this.requireSession());
  }

  /** Detach blocking subagents into the background (pause variant). */
  async background(client: V2Client): Promise<unknown> {
    return v2Background(client, this.requireSession());
  }

  async prompt(client: V2Client, text: string): Promise<unknown> {
    return v2Prompt(client, this.requireSession(), text);
  }

  async generate(client: V2Client, prompt: string): Promise<unknown> {
    return v2Generate(client, this.requireSession(), prompt);
  }

  async fork(client: V2Client, before?: string): Promise<V2SessionInfo> {
    return v2ForkSession(client, this.requireSession(), before);
  }

  async move(client: V2Client, directory: string): Promise<unknown> {
    return v2MoveSession(client, this.requireSession(), directory);
  }

  async compact(client: V2Client): Promise<unknown> {
    return v2CompactSession(client, this.requireSession());
  }
}
