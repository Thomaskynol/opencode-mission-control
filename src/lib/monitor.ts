import { EventEmitter } from 'events';
import { getRunningJobs, getJob, updateJob, resolveJobPassword, type Job } from './job-state.js';
import { isPaneRunning, capturePane, captureExitStatus } from './tmux.js';
import { loadConfig } from './config.js';
import { readReport } from './reports.js';
import {
  QuestionRelay,
  type PermissionRequest,
  type PendingQuestion,
  addPendingQuestion,
  removePendingQuestion,
  clearPendingQuestionsForJob,
  buildTaskSummary,
} from './question-relay.js';
import {
  persistPendingQuestion,
  dropPersistedQuestion,
} from './durable-state.js';
import {
  createV2Client,
  v2GetForm,
  v2GetSession,
  v2ListForms,
  type V2Client,
} from './sdk-client.js';
import { loadPlan } from './plan-state.js';
import { PermissionPolicy, type PermissionPolicyConfig } from './permission-policy.js';

type JobEventType = 'complete' | 'failed' | 'blocked' | 'needs_review' | 'awaiting_input' | 'agent_report' | 'question';

interface IdleTracker {
  lastOutputHash: string;
  lastChangedAt: number;
}

interface EventAccumulator {
  filesEdited: string[];
  currentTool?: string;
  lastActivityAt: number;
  eventCount: number;
  currentFile?: string;
}

interface SSESubscription {
  abortController: AbortController;
  client: V2Client;
  reconnectAttempts: number;
}

const MAX_EVENTS_PER_JOB = 100;
const SSE_INITIAL_BACKOFF_MS = 100;
const SSE_MAX_BACKOFF_MS = 30000;
const SSE_BACKOFF_FACTOR = 2;

export interface JobMonitorOptions {
  pollInterval?: number;
  idleThreshold?: number;
}

function hashOutput(output: string): string {
  return Bun.hash(output).toString(36);
}

/**
 * Scope a v2 envelope to one worker session. Durable events carry the
 * session in `durable.aggregateID`; live ones in `data.sessionID`.
 * Envelopes without any session pointer (heartbeats, server.connected)
 * never belong to a job.
 */
export function eventBelongsToSession(event: any, sessionID: string | undefined): boolean {
  if (!sessionID) return false;
  if (typeof event?.data?.sessionID === 'string') return event.data.sessionID === sessionID;
  if (typeof event?.durable?.aggregateID === 'string') {
    return event.durable.aggregateID === sessionID;
  }
  if (typeof event?.sessionID === 'string') return event.sessionID === sessionID;
  return false;
}

type SessionState = 'idle' | 'streaming' | 'awaiting_input' | 'unknown';

function detectSessionState(output: string): SessionState {
  const lines = output.split('\n');
  const bottomChunk = lines.slice(-10).join('\n');

  if (bottomChunk.includes('⬝') || bottomChunk.includes('esc interrupt')) {
    return 'streaming';
  }

  const isQuestionPrompt = bottomChunk.includes('↑↓ select') || bottomChunk.includes('enter submit') || bottomChunk.includes('esc dismiss');
  if (isQuestionPrompt) {
    return 'awaiting_input';
  }

  if (bottomChunk.includes('ctrl+p commands')) {
    return 'idle';
  }

  return 'unknown';
}

export class JobMonitor extends EventEmitter {
  private pollInterval: number;
  private idleThreshold: number;
  private intervalId?: Timer;
  private isRunning = false;
  private idleTrackers: Map<string, IdleTracker> = new Map();
  private awaitingInputNotified: Set<string> = new Set();
  private eventAccumulators: Map<string, EventAccumulator> = new Map();
  private sseSubscriptions: Map<string, SSESubscription> = new Map();
  private questionRelay: QuestionRelay;

  private explicitIdleThreshold: boolean;

  constructor(options: JobMonitorOptions = {}) {
    super();
    this.pollInterval = options.pollInterval ?? 10000;
    this.idleThreshold = options.idleThreshold ?? 300000;
    this.explicitIdleThreshold = options.idleThreshold !== undefined;
    this.questionRelay = new QuestionRelay();

    const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
    if (this.pollInterval < 10000 && !isTest) {
      throw new Error('Poll interval must be at least 10000ms (10s)');
    }
  }

  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    if (!this.explicitIdleThreshold) {
      this.loadIdleThreshold();
    }
    this.intervalId = setInterval(() => {
      this.poll().catch((error) => {
        console.error('Error during job monitoring poll:', error);
      });
    }, this.pollInterval);

    this.poll().catch((error) => {
      console.error('Error during initial job monitoring poll:', error);
    });
  }

  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.idleTrackers.clear();
    this.awaitingInputNotified.clear();
    this.cleanupSSESubscriptions();
    this.questionRelay.dispose();
  }

  /** Conductor-side drive: run one poll cycle on demand (reconciler cover). */
  async pollNow(): Promise<void> {
    await this.poll();
  }

  /** Whether the interval loop is active (idempotent start guard). */
  isActive(): boolean {
    return this.isRunning;
  }

  private cleanupSSESubscriptions(): void {
    for (const [jobId, subscription] of this.sseSubscriptions) {
      subscription.abortController.abort();
      this.sseSubscriptions.delete(jobId);
      this.questionRelay.cleanup(jobId);
    }
  }

  private cleanupSSEForJob(jobId: string): void {
    const subscription = this.sseSubscriptions.get(jobId);
    if (subscription) {
      subscription.abortController.abort();
      this.sseSubscriptions.delete(jobId);
      this.questionRelay.cleanup(jobId);
    }
    clearPendingQuestionsForJob(jobId);
  }

  on(event: JobEventType, handler: (job: Job, ...extra: unknown[]) => void): this {
    return super.on(event, handler);
  }

  private async loadIdleThreshold(): Promise<void> {
    try {
      const config = await loadConfig();
      this.idleThreshold = config.idleThreshold;
    } catch {}
  }

  private getOrCreateEventAccumulator(jobId: string): EventAccumulator {
    if (!this.eventAccumulators.has(jobId)) {
      this.eventAccumulators.set(jobId, {
        filesEdited: [],
        lastActivityAt: Date.now(),
        eventCount: 0,
      });
    }
    return this.eventAccumulators.get(jobId)!;
  }

  private updateEventAccumulator(
    jobId: string,
    updates: Partial<Omit<EventAccumulator, 'eventCount'>>,
  ): void {
    const accumulator = this.getOrCreateEventAccumulator(jobId);
    accumulator.eventCount++;
    accumulator.lastActivityAt = Date.now();

    if (updates.currentTool !== undefined) {
      accumulator.currentTool = updates.currentTool;
    }
    if (updates.currentFile !== undefined) {
      accumulator.currentFile = updates.currentFile;
    }
    if (updates.filesEdited !== undefined) {
      for (const file of updates.filesEdited) {
        if (!accumulator.filesEdited.includes(file)) {
          accumulator.filesEdited.push(file);
          if (accumulator.filesEdited.length > MAX_EVENTS_PER_JOB) {
            accumulator.filesEdited.shift();
          }
        }
      }
    }
  }

  private async subscribeToSSE(job: Job): Promise<void> {
    if (!job.port) {
      return;
    }

    if (this.sseSubscriptions.has(job.id)) {
      return;
    }

    const abortController = new AbortController();
    const config = await loadConfig().catch(() => undefined);
    const password = resolveJobPassword(job, config?.serverPassword);
    if (!password) {
      // Fail-closed: serve always requires auth; an unauthenticated SSE
      // stream would just 401-loop. Skip until a credential exists.
      console.warn(
        `[Monitor] No serve password for job ${job.name} (job or config) — skipping SSE subscribe, fail-closed.`,
      );
      return;
    }
    const client = createV2Client(job.port, password);
    this.questionRelay.setPassword(password);

    this.sseSubscriptions.set(job.id, {
      abortController,
      client,
      reconnectAttempts: 0,
    });

    this.backfillPendingQuestions(job, client).catch(() => {});

    // demo-r5 race: the worker session can reach a terminal outcome before
    // this subscription opens (the stream is volatile, no replay). One-shot
    // read of the current outcome; live events stay authoritative after.
    this.syncSessionOutcome(job, client).catch(() => {});

    this.processSSEStream(job, client, abortController).catch((error) => {
      console.error(`[Monitor] SSE stream error for job ${job.name}:`, error);
    });
  }

  /**
   * Backfill from the authoritative v2 surface: pending session forms are
   * questions the agent is waiting on right now (covers restarts where the
   * `form.created` event fired while we were disconnected).
   */
  private async backfillPendingQuestions(job: Job, client: V2Client): Promise<void> {
    if (!job.remoteSessionID) return;

    try {
      const forms = await v2ListForms(client, job.remoteSessionID);
      for (const form of forms) {
        await this.registerFormQuestion(job, form.id);
      }
    } catch {
      // Non-fatal: backfill failure shouldn't block SSE subscription
    }
  }

  /**
   * One-shot initial sync: read the current remote outcome at subscribe
   * time and route terminal ones through the event path (idempotent —
   * handleSSEEvent drops events for already-terminal jobs). 'interrupted'
   * and absent outcomes keep the job running; a failed read is fail-open
   * (warn, events stay authoritative). No continuous polling.
   *
   * Public for tests (see tests/lib/monitor-initial-sync.test.ts).
   */
  async syncSessionOutcome(job: Job, client: V2Client): Promise<void> {
    if (!job.remoteSessionID) return;
    let outcome: string | undefined;
    try {
      const session = await v2GetSession(client, job.remoteSessionID);
      // Session.Info.outcome (openapi 2.2.5): succeeded | failed | interrupted.
      outcome = (session as unknown as { outcome?: string }).outcome;
    } catch {
      console.warn(
        `[Monitor] Initial session sync failed for job ${job.name} — keeping SSE events authoritative.`,
      );
      return;
    }
    if (outcome === 'succeeded') {
      await this.handleSSEEvent(job, {
        type: 'session.execution.succeeded',
        data: { sessionID: job.remoteSessionID },
      });
    } else if (outcome === 'failed') {
      await this.handleSSEEvent(job, {
        type: 'session.execution.failed',
        data: { sessionID: job.remoteSessionID },
      });
    }
  }

  /**
   * Subscribe to the 2.1.4 native event stream (`GET /api/event`, SSE) and
   * dispatch this job's session events. Volatile by contract (slow
   * consumers overflow; disconnects miss events) — backfill above covers
   * the question gap on reconnect.
   */
  private async processSSEStream(
    job: Job,
    client: V2Client,
    abortController: AbortController,
  ): Promise<void> {
    while (this.isRunning && !abortController.signal.aborted) {
      try {
        const subscription = this.sseSubscriptions.get(job.id);
        if (subscription) {
          subscription.reconnectAttempts = 0;
        }

        await this.consumeEventStream(job, client, abortController);
      } catch (error) {
        if (abortController.signal.aborted) {
          break;
        }

        const subscription = this.sseSubscriptions.get(job.id);
        const reconnectAttempts = subscription?.reconnectAttempts ?? 0;
        const backoffMs = Math.min(
          SSE_INITIAL_BACKOFF_MS * Math.pow(SSE_BACKOFF_FACTOR, reconnectAttempts),
          SSE_MAX_BACKOFF_MS,
        );

        if (subscription) {
          subscription.reconnectAttempts = reconnectAttempts + 1;
        }

        console.warn(
          `[Monitor] SSE connection lost for job ${job.name}, reconnecting in ${backoffMs}ms (attempt ${reconnectAttempts + 1})`,
        );

        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  private async consumeEventStream(
    job: Job,
    client: V2Client,
    abortController: AbortController,
  ): Promise<void> {
    const response = await fetch(`${client.baseUrl}/event`, {
      headers: { ...client.headers, Accept: 'text/event-stream' },
      signal: abortController.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`event stream failed: HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice('data:'.length).trim();
          if (!payload) continue;
          try {
            const event = JSON.parse(payload);
            if (eventBelongsToSession(event, job.remoteSessionID)) {
              await this.handleSSEEvent(job, event);
            }
          } catch {
            // Non-fatal: skip malformed SSE payloads
          }
        }
        boundary = buffer.indexOf('\n\n');
      }

      if (abortController.signal.aborted) break;
    }
  }

  /**
   * Fetch a pending form and register it as the job's question (memory +
   * durable sidecar, so `mc_answer` works cross-process). No-op for settled
   * or already-known forms.
   */
  private async registerFormQuestion(job: Job, formID: string): Promise<void> {
    if (!job.remoteSessionID || !job.port) return;
    const subscription = this.sseSubscriptions.get(job.id);
    if (!subscription) return;

    let form;
    try {
      form = await v2GetForm(subscription.client, job.remoteSessionID, formID);
    } catch {
      return;
    }
    if (form.state?.status !== 'pending') return;

    const [head] = form.fields;
    const description = [form.title, head?.description].filter(Boolean).join(' — ');
    const toolMeta = (form.metadata as { tool?: { id?: unknown } } | undefined)?.tool;
    const pending: PendingQuestion = {
      jobId: job.id,
      jobName: job.name,
      taskSummary: buildTaskSummary(job.prompt),
      partId: form.id,
      callID: typeof toolMeta?.id === 'string' ? toolMeta.id : form.id,
      remoteSessionID: job.remoteSessionID,
      port: job.port,
      question: head?.title && head.title !== form.title ? `${form.title}: ${head.title}` : form.title,
      options: (head?.options ?? []).map((o) => ({ label: o.label, description: o.description })),
      header: description || undefined,
      multiple: false,
      detectedAt: Date.now(),
    };

    const isNew = addPendingQuestion(pending);
    if (isNew) {
      await persistPendingQuestion(pending).catch(() => {});
      this.emit('question', job, pending);
    }
  }

  private async handleSSEEvent(job: Job, event: any): Promise<void> {
    const eventType = event.type || event.event;

    // Stale-event guard: the subscribed job may have been killed, finished,
    // or cleaned up after this stream opened. updateJob throws on invalid
    // transitions (fail-closed); writing a terminal event for a non-running
    // job would throw inside the stream loop and turn into a reconnect
    // storm. Cleanup and drop the event instead.
    if (
      eventType === 'session.status' ||
      eventType === 'session.idle' ||
      eventType === 'session.error' ||
      eventType === 'session.execution.succeeded' ||
      eventType === 'session.execution.failed'
    ) {
      let stillRunning = false;
      try {
        const fresh = await getJob(job.id);
        stillRunning = fresh?.status === 'running';
      } catch {
        // Fail open: let updateJob validate. A throw there is per-event,
        // never a state this guard invented.
        stillRunning = true;
      }
      if (!stillRunning) {
        this.cleanupSSEForJob(job.id);
        return;
      }
    }

    switch (eventType) {
      case 'session.execution.succeeded': {
        const now = new Date().toISOString();
        this.cleanupSSEForJob(job.id);
        await updateJob(job.id, { status: 'completed', completedAt: now });
        this.emit('complete', { ...job, status: 'completed', completedAt: now });
        break;
      }

      case 'session.execution.failed': {
        const now = new Date().toISOString();
        this.cleanupSSEForJob(job.id);
        await updateJob(job.id, { status: 'failed', completedAt: now });
        this.emit('failed', { ...job, status: 'failed', completedAt: now });
        break;
      }

      case 'session.execution.interrupted': {
        // Pause acknowledgement: the loop stopped, code untouched. The
        // pause tool already wrote the milestone; nothing to transition.
        break;
      }

      case 'form.created': {
        const formID = event.data?.id;
        if (typeof formID === 'string') {
          await this.registerFormQuestion(job, formID);
        }
        break;
      }

      case 'form.replied':
      case 'form.cancelled': {
        const formID = event.data?.id;
        if (typeof formID === 'string') {
          removePendingQuestion(job.id, formID);
          await dropPersistedQuestion(job.id, formID).catch(() => {});
        }
        break;
      }

      case 'permission.asked': {
        void this.handlePermissionAsked(job, event);
        break;
      }

      case 'permission.replied':
      case 'permission.rejected': {
        const requestID = event.data?.id ?? event.data?.requestID;
        if (typeof requestID === 'string') {
          this.questionRelay.clearPermissionTimeout(job.id, requestID);
          removePendingQuestion(job.id, `perm:${requestID}`);
          try {
            await dropPersistedQuestion(job.id, `perm:${requestID}`);
          } catch {}
        }
        break;
      }
      case 'session.status': {
        const statusPayload = event.properties?.status;
        if (statusPayload?.type === 'idle') {
          const now = new Date().toISOString();
          this.cleanupSSEForJob(job.id);
          await updateJob(job.id, { status: 'completed', completedAt: now });
          this.emit('complete', { ...job, status: 'completed', completedAt: now });
        }
        break;
      }

      case 'session.idle': {
        const now = new Date().toISOString();
        this.cleanupSSEForJob(job.id);
        await updateJob(job.id, { status: 'completed', completedAt: now });
        this.emit('complete', { ...job, status: 'completed', completedAt: now });
        break;
      }

      case 'session.error': {
        const now = new Date().toISOString();
        this.cleanupSSEForJob(job.id);
        await updateJob(job.id, { status: 'failed', completedAt: now });
        this.emit('failed', { ...job, status: 'failed', completedAt: now });
        break;
      }

      case 'message.part.updated': {
        const part = event.properties?.part;
        if (part?.type === 'tool' && part.tool === 'question') {
          void this.handleQuestionToolUpdate(job, part);
        }
        this.updateEventAccumulator(job.id, { currentTool: 'streaming' });
        break;
      }

      case 'file.edited': {
        const filePath = event.properties?.path || event.path;
        if (filePath) {
          this.updateEventAccumulator(job.id, {
            filesEdited: [filePath],
            currentFile: filePath,
          });
        }
        break;
      }

      case 'permission.updated': {
        void this.handlePermissionUpdate(job, event);
        break;
      }
    }
  }

  private async handleQuestionToolUpdate(job: Job, part: any): Promise<void> {
    const state = part.state;
    if (!state) return;

    if (state.status === 'running') {
      const input = state.input ?? {};
      const questions = (input.questions ?? []) as Array<{
        question?: string;
        header?: string;
        options?: Array<{ label: string; description?: string }>;
        multiple?: boolean;
      }>;

      if (questions.length === 0) return;
      if (!job.remoteSessionID || !job.port) return;

      const first = questions[0];
      const pending: PendingQuestion = {
        jobId: job.id,
        jobName: job.name,
        taskSummary: buildTaskSummary(job.prompt),
        partId: part.id,
        callID: part.callID,
        remoteSessionID: job.remoteSessionID,
        port: job.port,
        question: first.question ?? '',
        options: first.options ?? [],
        header: first.header,
        multiple: first.multiple,
        detectedAt: Date.now(),
      };

      const isNew = addPendingQuestion(pending);
      if (isNew) {
        await persistPendingQuestion(pending).catch(() => {});
        this.emit('question', job, pending);
      }
    } else if (state.status === 'completed' || state.status === 'error') {
      removePendingQuestion(job.id, part.id);
      await dropPersistedQuestion(job.id, part.id).catch(() => {});
    }
  }

  /**
   * Route a v2 `permission.asked` event through the existing policy flow.
   * The v2 payload (`data: {id, action, resources, message}`) is adapted to
   * the legacy envelope the policy builders read.
   */
  private async handlePermissionAsked(job: Job, event: any): Promise<void> {
    try {
      const data = event.data ?? {};
      const adapted = {
        properties: {
          id: data.id ?? data.requestID,
          type: data.action,
          path: Array.isArray(data.resources) ? data.resources[0] : undefined,
          description: data.message ?? data.action,
          title: data.action,
        },
      };
      await this.handlePermissionUpdate(job, adapted);
    } catch (error) {
      console.error(`[Monitor] Failed to process permission ask for job ${job.name}:`, error);
    }
  }

  private inferPermissionType(event: any): PermissionRequest['type'] {
    const eventData = event.properties || event;
    const metadata = eventData.metadata ?? {};
    const typeHint = String(eventData.type || eventData.permissionType || metadata.type || '').toLowerCase();

    if (typeHint.includes('mcp') || typeHint.includes('tool')) {
      return 'mcp';
    }
    if (typeHint.includes('network') || typeHint.includes('http') || typeHint.includes('fetch') || typeHint.includes('web')) {
      return 'network';
    }
    if (typeHint.includes('shell') || typeHint.includes('command') || typeHint.includes('exec') || typeHint.includes('bash')) {
      return 'shell_command';
    }
    if (typeHint.includes('file') || typeHint.includes('write') || typeHint.includes('edit') || typeHint === 'read') {
      return 'file_operation';
    }

    return 'other';
  }

  private extractString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private extractPermissionPath(event: any): string | undefined {
    const eventData = event.properties || event;
    const metadata = eventData.metadata;

    const directPath = this.extractString(eventData.path)
      ?? this.extractString(eventData.file)
      ?? this.extractString(event.path);
    if (directPath) {
      return directPath;
    }

    if (metadata && typeof metadata === 'object') {
      const metadataPath = (metadata as Record<string, unknown>).path;
      return this.extractString(metadataPath);
    }

    return undefined;
  }

  private buildPermissionRequest(event: any): PermissionRequest {
    const eventData = event.properties || event;
    const rawType = this.extractString(eventData.type) || this.extractString(eventData.permissionType) || 'unknown';
    const path = this.extractPermissionPath(event);
    const description = this.extractString(eventData.description)
      || this.extractString(eventData.title)
      || this.extractString(event.description)
      || 'Unknown permission request';

    return {
      id: this.extractString(eventData.id) || this.extractString(event.id) || 'unknown',
      type: this.inferPermissionType(event),
      path,
      target: path,
      action: this.extractString(eventData.title) || rawType,
      rawType,
      description,
    };
  }

  private async resolvePolicyForJob(job: Job): Promise<PermissionPolicy> {
    const config = await loadConfig();
    const globalPolicy = config.defaultPermissionPolicy;

    let planPolicy: PermissionPolicyConfig | undefined;
    let jobPolicy: PermissionPolicyConfig | undefined;

    if (job.planId) {
      const plan = await loadPlan();
      if (plan && plan.id === job.planId) {
        planPolicy = plan.permissionPolicy;
        jobPolicy = plan.jobs.find((planJob) => planJob.name === job.name)?.permissionPolicy;
      }
    }

    return PermissionPolicy.resolvePolicy({
      jobPolicy,
      planPolicy,
      globalPolicy,
    });
  }

  private async handlePermissionUpdate(job: Job, event: any): Promise<void> {
    try {
      const permission = this.buildPermissionRequest(event);
      const accumulator = this.getOrCreateEventAccumulator(job.id);
      const policy = await this.resolvePolicyForJob(job);
      const decision = policy.evaluate(permission, { worktreePath: job.worktreePath });
      const decisionLog = policy.getDecisionLog();
      const lastLog = decisionLog[decisionLog.length - 1];
      const reason = lastLog?.reason ?? 'Permission decision from policy';

      if (decision === 'auto-approve') {
        await this.questionRelay.respondToPermission(job, permission.id, true, `Auto-approved by permission policy: ${reason}`);
        return;
      }

      if (decision === 'deny') {
        await this.questionRelay.respondToPermission(job, permission.id, false, `Denied by permission policy: ${reason}`);
        console.warn(`[Monitor] Permission denied by policy for job ${job.name}: ${permission.description}`);
        return;
      }

      await this.questionRelay.handlePermissionRequest(job, permission, accumulator.currentFile);
    } catch (error) {
      console.error(`[Monitor] Failed to process permission update for job ${job.name}:`, error);
    }
  }

  private isServeModeJob(job: Job): boolean {
    return job.port !== undefined && job.port > 0;
  }

  private async checkAgentReport(job: Job): Promise<boolean> {
    try {
      const report = await readReport(job.id);
      if (!report) {
        return false;
      }

      this.emit('agent_report', job, report);

      if (report.status === 'completed' || report.status === 'needs_review') {
        // Agent explicitly signaled completion — mark job done immediately
        const now = new Date().toISOString();
        this.idleTrackers.delete(job.id);
        await updateJob(job.id, { status: 'completed', completedAt: now });
        this.emit('complete', { ...job, status: 'completed', completedAt: now });
        if (report.status === 'needs_review') {
          this.emit('needs_review', { ...job, status: 'completed', completedAt: now }, report);
        }
        return true;
      } else if (report.status === 'blocked') {
        this.emit('blocked', job, report);
      }

      return false;
    } catch {
      // Non-fatal: report read failures should not disrupt monitoring
      return false;
    }
  }

  private async poll(): Promise<void> {
    const jobs = await getRunningJobs();
    const activeJobIds = new Set(jobs.map(j => j.id));

    for (const [id] of this.idleTrackers) {
      if (!activeJobIds.has(id)) {
        this.idleTrackers.delete(id);
      }
    }
    for (const id of this.awaitingInputNotified) {
      if (!activeJobIds.has(id)) {
        this.awaitingInputNotified.delete(id);
      }
    }

    for (const job of jobs) {
      try {
        if (this.isServeModeJob(job)) {
          await this.subscribeToSSE(job);
          continue;
        }

        let isRunning: boolean;
        try {
          isRunning = await isPaneRunning(job.tmuxTarget);
        } catch (paneError) {
          console.warn(
            `tmux error checking job ${job.id}, skipping this poll cycle:`,
            paneError instanceof Error ? paneError.message : paneError,
          );
          continue;
        }

        if (!isRunning) {
          this.idleTrackers.delete(job.id);
          this.awaitingInputNotified.delete(job.id);
          const now = new Date().toISOString();

          const exitCode = await captureExitStatus(job.tmuxTarget);
          const isFailed = exitCode !== undefined && exitCode !== 0;

          if (isFailed) {
            await updateJob(job.id, { status: 'failed', completedAt: now });
            this.emit('failed', { ...job, status: 'failed', completedAt: now });
          } else {
            await updateJob(job.id, { status: 'completed', completedAt: now });
            this.emit('complete', { ...job, status: 'completed', completedAt: now });
          }
          continue;
        }

        const reportHandled = await this.checkAgentReport(job);
        if (reportHandled) continue;

        const output = await capturePane(job.tmuxTarget, 50);
        const state = detectSessionState(output);

        if (state === 'awaiting_input' && !this.awaitingInputNotified.has(job.id)) {
          this.awaitingInputNotified.add(job.id);
          this.emit('awaiting_input', job);
        }

        const currentHash = hashOutput(output);
        const now = Date.now();
        const tracker = this.idleTrackers.get(job.id);

        if (!tracker) {
          this.idleTrackers.set(job.id, { lastOutputHash: currentHash, lastChangedAt: now });
          continue;
        }

        if (currentHash !== tracker.lastOutputHash) {
          tracker.lastOutputHash = currentHash;
          tracker.lastChangedAt = now;
          continue;
        }

        if (now - tracker.lastChangedAt >= this.idleThreshold && state === 'idle') {
          this.idleTrackers.delete(job.id);
          this.awaitingInputNotified.delete(job.id);
          const completedAt = new Date().toISOString();
          await updateJob(job.id, { status: 'completed', completedAt });
          this.emit('complete', { ...job, status: 'completed', completedAt });
        }
      } catch (error) {
        console.error(`Error checking job ${job.id}:`, error);
      }
    }
  }

  getEventAccumulator(jobId: string): EventAccumulator | undefined {
    return this.eventAccumulators.get(jobId);
  }
}
