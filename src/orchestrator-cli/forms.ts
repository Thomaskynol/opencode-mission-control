import type { PendingQuestion } from '../lib/question-relay';
import {
  findPendingQuestionByJobName,
  removePendingQuestion,
} from '../lib/question-relay';
import {
  loadRuntimeSnapshot,
  updateRuntimeSnapshot,
} from '../lib/durable-state';

/**
 * M6 human lane: essential questions as durable, respondable forms.
 *
 * A worker question lives in two places: the in-memory relay (fast path)
 * and the `runtime-state.json` sidecar (survives kill -9). Answering from
 * either store removes it from both, so a question is never re-delivered.
 *
 * 2.1.4 limit: `question.*` has no HTTP endpoint. Agent questions are
 * answered by sending a text prompt to the job's session (forms below);
 * only `permission.*` uses the permission reply endpoint. See docs/m6-human.md.
 */

/** Unanswered essential questions auto-resolve so independent fronts keep running. */
export const QUESTION_AUTO_RESPONSE_MS = 120_000;
export const QUESTION_DEFAULT_RESPONSE = 'use your best judgment';

export interface AnswerSender {
  (port: number, sessionID: string, response: string): Promise<void>;
}

/** Render a question as a respondable form (numbered options + free text). */
export function renderQuestionForm(q: PendingQuestion): string {
  const lines = [
    `❓ Job "${q.jobName}" asks:`,
    '',
    q.question,
    '',
  ];
  if (q.header) {
    lines.push(`Context: ${q.header}`, '');
  }
  if (q.options.length > 0) {
    lines.push('Options:');
    q.options.forEach((opt, i) => {
      lines.push(`  ${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ''}`);
    });
    lines.push('');
  }
  if (q.multiple) {
    lines.push('(Multiple selections allowed)', '');
  }
  lines.push(
    `Reply with the option number/label, or free-text instructions.`,
    `No reply within ${QUESTION_AUTO_RESPONSE_MS / 1000}s → "${QUESTION_DEFAULT_RESPONSE}".`,
    `Other jobs keep running meanwhile.`,
  );
  return lines.join('\n');
}

export async function listPersistedQuestions(): Promise<PendingQuestion[]> {
  const snapshot = await loadRuntimeSnapshot();
  return snapshot?.pendingQuestions ?? [];
}

/** Persist a question to the sidecar without dropping other runtime sections. */
export async function persistPendingQuestion(q: PendingQuestion): Promise<void> {
  // Atomic read-modify-write under the file lock: a load-then-save here
  // would lose a concurrent process's update.
  await updateRuntimeSnapshot((current) => ({
    pendingQuestions: [
      ...(current.pendingQuestions ?? []).filter(
        (p) => !(p.jobId === q.jobId && p.partId === q.partId),
      ),
      q,
    ],
    messageBus: current.messageBus ?? {},
    accumulators: current.accumulators ?? {},
    sseCursor: current.sseCursor ?? {},
  }));
}

export async function dropPersistedQuestion(jobId: string, partId: string): Promise<void> {
  // Atomic read-modify-write under the file lock (see above). No-op when
  // no sidecar exists yet.
  await updateRuntimeSnapshot((current) => ({
    pendingQuestions: (current.pendingQuestions ?? []).filter(
      (p) => !(p.jobId === jobId && p.partId === partId),
    ),
    messageBus: current.messageBus ?? {},
    accumulators: current.accumulators ?? {},
    sseCursor: current.sseCursor ?? {},
  }));
}

/**
 * Answer a pending question from memory first, then the durable sidecar.
 * Removes it from both stores so it is never asked twice.
 */
export async function answerQuestion(
  jobName: string,
  response: string,
  sender: AnswerSender,
): Promise<string> {
  const live = findPendingQuestionByJobName(jobName);
  if (live) {
    await sender(live.port, live.remoteSessionID, response);
    removePendingQuestion(live.jobId, live.partId);
    await dropPersistedQuestion(live.jobId, live.partId);
    return `Answer sent to job "${jobName}": "${response}"`;
  }

  const persisted = (await listPersistedQuestions()).filter(
    (q) => q.jobName === jobName,
  );
  if (persisted.length === 0) {
    throw new Error(
      `No pending question found for job "${jobName}". It may have been answered, timed out, or reconciled away on boot.`,
    );
  }
  const q = persisted[0];
  await sender(q.port, q.remoteSessionID, response);
  await dropPersistedQuestion(q.jobId, q.partId);
  return `Answer sent to job "${jobName}" (from durable sidecar): "${response}"`;
}
