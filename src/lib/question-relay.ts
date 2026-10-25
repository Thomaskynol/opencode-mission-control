import type { Job } from './job-state.js';
import { createV2Client, v2Prompt, v2ReplyPermission, type V2Client } from './sdk-client.js';
import { isGitPushText } from './permission-policy.js';

/**
 * Publishing-like permission (push/PR/publish/deploy): must never
 * auto-approve, even inside the worktree. Mirrors
 * `requiresHumanAuth` (`permission-policy.ts`) for the relay's own
 * `shouldAutoApprove` path so a policy `ask-user` cannot be re-approved
 * here.
 */
function isPublishingPermissionText(haystack: string): boolean {
  if (isGitPushText(haystack)) return true;
  const lower = haystack.toLowerCase();
  return (
    /\bgh\s+pr\s+(create|merge)\b/.test(lower) ||
    /\b(npm|pnpm|yarn)\b[^\n]*\bpublish\b/.test(lower) ||
    /\bdeploy\b/.test(lower)
  );
}

function permissionHaystack(p: { action?: string; description: string; target?: string; path?: string }): string {
  return [p.action, p.description, p.target, p.path].filter((x): x is string => typeof x === 'string').join('\n');
}

/**
 * A pending mcp_question from a serve-mode job's agent.
 * Keyed by `{jobId}:{partId}` for dedup.
 */
export interface PendingQuestion {
  jobId: string;
  jobName: string;
  taskSummary: string;
  partId: string;
  callID: string;
  remoteSessionID: string;
  port: number;
  question: string;
  options: Array<{ label: string; description?: string }>;
  header?: string;
  multiple?: boolean;
  detectedAt: number;
}

/**
 * In-memory store for pending questions across all jobs.
 */
const pendingQuestions = new Map<string, PendingQuestion>();

function pendingKey(jobId: string, partId: string): string {
  return `${jobId}:${partId}`;
}

/**
 * Register a pending question detected from an SSE event.
 * Returns true if this is a new question (not a duplicate).
 */
export function addPendingQuestion(question: PendingQuestion): boolean {
  const key = pendingKey(question.jobId, question.partId);
  if (pendingQuestions.has(key)) {
    return false;
  }
  pendingQuestions.set(key, question);
  return true;
}

/**
 * Remove a pending question (tool completed or errored).
 */
export function removePendingQuestion(jobId: string, partId: string): boolean {
  return pendingQuestions.delete(pendingKey(jobId, partId));
}

/**
 * Get all pending questions for a specific job.
 */
export function getPendingQuestionsForJob(jobId: string): PendingQuestion[] {
  const result: PendingQuestion[] = [];
  for (const [key, q] of pendingQuestions) {
    if (key.startsWith(`${jobId}:`)) {
      result.push(q);
    }
  }
  return result;
}

/**
 * Get a specific pending question by job name (for mc_answer tool).
 */
export function findPendingQuestionByJobName(jobName: string): PendingQuestion | undefined {
  for (const q of pendingQuestions.values()) {
    if (q.jobName === jobName) {
      return q;
    }
  }
  return undefined;
}

/**
 * Clear all pending questions for a job (cleanup).
 */
export function clearPendingQuestionsForJob(jobId: string): void {
  for (const key of pendingQuestions.keys()) {
    if (key.startsWith(`${jobId}:`)) {
      pendingQuestions.delete(key);
    }
  }
}

/**
 * Get count of all pending questions.
 */
export function getPendingQuestionCount(): number {
  return pendingQuestions.size;
}

/**
 * Answer a pending question by sending a user message to the job's session.
 * This unblocks the agent waiting on the question tool call.
 */
export async function answerPendingQuestion(
  question: PendingQuestion,
  response: string,
  password?: string,
): Promise<void> {
  const client = createV2Client(question.port, password);
  await v2Prompt(client, question.remoteSessionID, response);
  pendingQuestions.delete(pendingKey(question.jobId, question.partId));
}

/**
 * Build a notification message for relaying a question to the launching session.
 */
export function buildQuestionRelayMessage(question: PendingQuestion): string {
  const parts: string[] = [
    `❓ Job "${question.jobName}" is asking a question.`,
    `Task: ${question.taskSummary}`,
    '',
    'IMPORTANT: You MUST use mcp_question to present this question to the user with the EXACT same options below,',
    `plus one final option labeled "Attach to job" with description "Open the job's terminal to see full context before answering".`,
    `If the user picks "Attach to job", run mc_attach(name: "${question.jobName}") instead of mc_answer.`,
    `Otherwise, use mc_answer(name: "${question.jobName}", response: "<user's choice>") to send their answer back.`,
    '',
  ];

  if (question.header) {
    parts.push(`Header: ${question.header}`);
  }

  parts.push(`Question: ${question.question}`);

  if (question.options.length > 0) {
    parts.push('');
    parts.push('Options (pass these exactly to mcp_question):');
    for (const opt of question.options) {
      const desc = opt.description ? ` — ${opt.description}` : '';
      parts.push(`  - ${opt.label}${desc}`);
    }
  }

  if (question.multiple) {
    parts.push('');
    parts.push('(Allow multiple selections)');
  }

  return parts.join('\n');
}

/**
 * Permission request from an SSE event
 */
export interface PermissionRequest {
  id: string;
  type: 'file_operation' | 'shell_command' | 'network' | 'mcp' | 'other';
  path?: string;
  description: string;
  action?: string;
  target?: string;
  rawType?: string;
}

/**
 * Context for relaying a question to the launching session
 */
export interface QuestionContext {
  jobName: string;
  taskSummary: string;
  currentFile?: string;
  permissionRequest?: PermissionRequest;
}

/**
 * Result of handling a permission request
 */
export interface PermissionResult {
  approved: boolean;
  autoApproved: boolean;
  reason: string;
}

/**
 * Configuration for question relay behavior
 */
export interface QuestionRelayConfig {
  autoResponseTimeoutMs: number;
  defaultResponse: string;
}

const DEFAULT_CONFIG: QuestionRelayConfig = {
  autoResponseTimeoutMs: 120_000, // 2 minutes
  defaultResponse: 'use your best judgment',
};

/**
 * Build a task summary from job prompt (first ~120 chars)
 */
export function buildTaskSummary(prompt: string): string {
  const maxLen = 120;
  if (prompt.length <= maxLen) {
    return prompt;
  }
  return prompt.slice(0, maxLen - 3) + '...';
}

/**
 * Check if a path is inside the worktree
 */
export function isPathInsideWorktree(path: string, worktreePath: string): boolean {
  const normalizedPath = path.replace(/\\/g, '/');
  const normalizedWorktree = worktreePath.replace(/\\/g, '/');
  return normalizedPath.startsWith(normalizedWorktree);
}

/**
 * Determine if a permission request should be auto-approved
 */
export function shouldAutoApprove(
  permission: PermissionRequest,
  worktreePath: string,
): PermissionResult {
  // Publishing actions never auto-approve, even inside the worktree.
  // Without this, a policy `ask-user` for `git push` inside the worktree
  // would be re-approved here and push without the operator.
  if (isPublishingPermissionText(permissionHaystack(permission))) {
    return {
      approved: false,
      autoApproved: false,
      reason: 'Publishing action (push/PR/deploy) requires explicit human authorization',
    };
  }

  // MCP tool execution: auto-approve
  if (permission.type === 'mcp') {
    return {
      approved: true,
      autoApproved: true,
      reason: 'MCP tool execution is auto-approved',
    };
  }

  // File operations: check if inside worktree
  if (permission.type === 'file_operation' && permission.path) {
    if (isPathInsideWorktree(permission.path, worktreePath)) {
      return {
        approved: true,
        autoApproved: true,
        reason: 'File operation inside worktree is auto-approved',
      };
    }
    return {
      approved: false,
      autoApproved: false,
      reason: 'File operation outside worktree requires user approval',
    };
  }

  // Shell commands: check if inside worktree context
  if (permission.type === 'shell_command') {
    // Shell commands are generally safe inside worktree, but check if path is specified
    if (!permission.path || isPathInsideWorktree(permission.path, worktreePath)) {
      return {
        approved: true,
        autoApproved: true,
        reason: 'Shell command inside worktree is auto-approved',
      };
    }
    return {
      approved: false,
      autoApproved: false,
      reason: 'Shell command outside worktree requires user approval',
    };
  }

  // Network/dangerous operations: always relay to user
  if (permission.type === 'network') {
    return {
      approved: false,
      autoApproved: false,
      reason: 'Network operation requires user approval',
    };
  }

  // Unknown/other types: relay to user
  return {
    approved: false,
    autoApproved: false,
    reason: 'Unknown permission type requires user approval',
  };
}

/**
 * Build the question prompt to send to the launching session
 */
export function buildQuestionPrompt(context: QuestionContext): string {
  const parts: string[] = [
    `🔔 Job "${context.jobName}" needs your attention:`,
    '',
    `Task: ${context.taskSummary}`,
  ];

  if (context.currentFile) {
    parts.push(`Current file: ${context.currentFile}`);
  }

  if (context.permissionRequest) {
    parts.push('');
    parts.push('Permission request:');
    parts.push(`  Type: ${context.permissionRequest.type}`);
    parts.push(`  Description: ${context.permissionRequest.description}`);
    if (context.permissionRequest.path) {
      parts.push(`  Path: ${context.permissionRequest.path}`);
    }
  }

  parts.push('');
  parts.push('Options:');
  parts.push('  - Reply "yes" to approve');
  parts.push('  - Reply "no" to deny');
  parts.push('  - Reply with specific instructions');
  parts.push('  - Let it decide: use its best judgment (auto-response after timeout)');

  return parts.join('\n');
}

/**
 * Question relay handler for managing permission requests
 */
export class QuestionRelay {
  private config: QuestionRelayConfig;
  private pendingResponses: Map<string, Timer> = new Map();
  private clients: Map<number, V2Client> = new Map();
  private password?: string;

  constructor(config: Partial<QuestionRelayConfig> = {}, password?: string) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.password = password;
  }

  /** Set the serve password after construction (monitor loads it from config). */
  setPassword(password: string | undefined): void {
    this.password = password;
    this.clients.clear();
  }

  /**
   * Get or create a v2 client for a job's port
   */
  private getClient(port: number): V2Client {
    const key = port;
    if (!this.clients.has(key)) {
      this.clients.set(key, createV2Client(port, this.password));
    }
    return this.clients.get(key)!;
  }

  /**
   * Handle a permission request from an SSE event.
   * Auto-approvals reply on the worker's own session; escalations no longer
   * HTTP-post to the operator session (launchSessionID lives on the
   * control-center, never on the worker's serve instance — that POST always
   * missed). Ask-user requests are now visible as pending questions
   * (memory + durable sidecar → `mc_overview`, dashboard `questions`,
   * TUI `questions`/`follow`) and keep the worker unblocked via the
   * auto-response timeout. Publishing escalations auto-deny on timeout
   * instead of approving, so a push can never be authorized by silence.
   */
  async handlePermissionRequest(
    job: Job,
    permission: PermissionRequest,
    _currentFile?: string,
  ): Promise<PermissionResult> {
    const result = shouldAutoApprove(permission, job.worktreePath);

    if (result.autoApproved) {
      // Auto-approve the permission on the worker session.
      if (job.port && job.remoteSessionID) {
        try {
          const client = this.getClient(job.port);
          await this.replyToPermission(client, job.remoteSessionID, permission.id, true);
        } catch (error) {
          console.error(`[QuestionRelay] Failed to auto-approve permission for job ${job.name}:`, error);
        }
      } else {
        console.warn(
          `[QuestionRelay] Cannot auto-approve permission for job ${job.name}: missing serve port or remote session.`,
        );
      }
      return result;
    }

    // Escalation path: make it operator-visible (memory + sidecar) so
    // `mc_overview`/dashboard/`questions` show it. Best-effort persist:
    // unit callers without a mocked data dir still get the memory entry.
    const publishing = isPublishingPermissionText(permissionHaystack(permission));
    const pending: PendingQuestion = {
      jobId: job.id,
      jobName: job.name,
      taskSummary: buildTaskSummary(job.prompt),
      partId: `perm:${permission.id}`,
      callID: permission.id,
      remoteSessionID: job.remoteSessionID ?? '',
      port: job.port ?? 0,
      question: `Permission needed [${permission.type}]: ${permission.description}${permission.path ? ` (${permission.path})` : ''}`,
      options: [
        { label: 'approve', description: 'Allow once' },
        { label: 'deny', description: 'Deny' },
      ],
      header: `Permission escalation for job "${job.name}"`,
      multiple: false,
      detectedAt: Date.now(),
    };
    addPendingQuestion(pending);
    try {
      const { persistPendingQuestion } = await import('./durable-state.js');
      await persistPendingQuestion(pending);
    } catch {
      // Memory entry above already makes it visible this process;
      // sidecar sync retries on the next monitor tick/boot.
    }

    if (job.port && job.remoteSessionID) {
      this.setupAutoResponse(job, permission.id, !publishing);
    } else {
      console.warn(`[QuestionRelay] Cannot escalate permission for job ${job.name}: missing serve port or remote session.`);
    }

    return result;
  }

  async respondToPermission(
    job: Job,
    permissionId: string,
    approved: boolean,
    message?: string,
  ): Promise<void> {
    if (!job.port || !job.remoteSessionID) {
      return;
    }

    const client = this.getClient(job.port);
    await this.replyToPermission(client, job.remoteSessionID, permissionId, approved, message);
  }

  /**
   * Set up automatic response after timeout.
   * Publishing escalations auto-deny (never approve by silence); ordinary
   * escalations approve with the default response so independent fronts
   * keep moving.
   */
  private setupAutoResponse(job: Job, permissionId: string, autoApprove = true): void {
    // Clear any existing timeout for this permission
    const existingKey = `${job.id}:${permissionId}`;
    if (this.pendingResponses.has(existingKey)) {
      clearTimeout(this.pendingResponses.get(existingKey)!);
    }

    // Set new timeout
    const timeoutId = setTimeout(async () => {
      try {
        if (job.port && job.remoteSessionID) {
          await this.replyToPermission(
            this.getClient(job.port),
            job.remoteSessionID,
            permissionId,
            autoApprove,
            autoApprove ? this.config.defaultResponse : 'Denied by policy: publishing requires explicit human authorization',
          );
        }
        console.log(`[QuestionRelay] Auto-${autoApprove ? 'approved' : 'denied'} permission ${permissionId} for job ${job.id}`);
      } catch (error) {
        console.error(`[QuestionRelay] Failed to auto-respond for job ${job.id}:`, error);
      } finally {
        this.pendingResponses.delete(existingKey);
        removePendingQuestion(job.id, `perm:${permissionId}`);
        try {
          const { dropPersistedQuestion } = await import('./durable-state.js');
          await dropPersistedQuestion(job.id, `perm:${permissionId}`);
        } catch {}
      }
    }, this.config.autoResponseTimeoutMs);

    this.pendingResponses.set(existingKey, timeoutId);
  }

  /**
   * Reply to a pending permission request owned by the worker session.
   * Least privilege: approvals are single-use (`once`), never standing.
   */
  private async replyToPermission(
    client: V2Client,
    sessionID: string,
    permissionId: string,
    approved: boolean,
    message?: string,
  ): Promise<void> {
    try {
      await v2ReplyPermission(
        client,
        sessionID,
        permissionId,
        approved ? 'once' : 'reject',
        message ?? (approved ? 'Approved' : 'Denied'),
      );
    } catch (error) {
      console.error(`[QuestionRelay] Failed to reply to permission ${permissionId}:`, error);
      throw error;
    }
  }

  /**
   * Handle user response to a relayed question
   * Called when the user replies in the launching session
   */
  async handleUserResponse(
    job: Job,
    permissionId: string,
    response: string,
  ): Promise<void> {
    // Clear the auto-response timeout
    const key = `${job.id}:${permissionId}`;
    if (this.pendingResponses.has(key)) {
      clearTimeout(this.pendingResponses.get(key)!);
      this.pendingResponses.delete(key);
    }

    if (!job.port || !job.remoteSessionID) {
      return;
    }

    // Parse user response
    const normalizedResponse = response.toLowerCase().trim();
    let approved: boolean;
    let message: string;

    if (normalizedResponse === 'yes' || normalizedResponse === 'y' || normalizedResponse === 'approve') {
      approved = true;
      message = 'Approved by user';
    } else if (normalizedResponse === 'no' || normalizedResponse === 'n' || normalizedResponse === 'deny') {
      approved = false;
      message = 'Denied by user';
    } else if (normalizedResponse.includes('let it decide') || normalizedResponse.includes('best judgment')) {
      approved = true;
      message = 'Let agent use best judgment';
    } else {
      // Treat as specific instructions - approve with the message
      approved = true;
      message = response;
    }

    try {
      const client = this.getClient(job.port);
      await this.replyToPermission(client, job.remoteSessionID, permissionId, approved, message);
    } catch (error) {
      console.error(`[QuestionRelay] Failed to send user response for job ${job.name}:`, error);
    }
  }

  /**
   * Clean up resources for a job
   */
  cleanup(jobId: string): void {
    // Clear all pending timeouts for this job
    for (const [key, timeoutId] of this.pendingResponses) {
      if (key.startsWith(`${jobId}:`)) {
        clearTimeout(timeoutId);
        this.pendingResponses.delete(key);
      }
    }
  }

  /**
   * Clear all resources
   */
  dispose(): void {
    for (const timeoutId of this.pendingResponses.values()) {
      clearTimeout(timeoutId);
    }
    this.pendingResponses.clear();
    this.clients.clear();
  }

  /** Clear the auto-response timeout for one settled permission request. */
  clearPermissionTimeout(jobId: string, permissionId: string): void {
    const key = `${jobId}:${permissionId}`;
    const timeoutId = this.pendingResponses.get(key);
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      this.pendingResponses.delete(key);
    }
  }
}
