import type { PendingQuestion } from '../lib/question-relay';
import {
  findPendingQuestionByJobName,
  removePendingQuestion,
} from '../lib/question-relay';
import {
  persistPendingQuestion,
  dropPersistedQuestion,
  listPersistedQuestions,
} from '../lib/durable-state';

export { persistPendingQuestion, dropPersistedQuestion, listPersistedQuestions };
import {
  createV2Client,
  v2GetForm,
  v2ReplyForm,
} from '../lib/sdk-client';
import { loadConfig } from '../lib/config';

/**
 * M6 human lane: essential questions as durable, respondable forms.
 *
 * A worker question lives in two places: the in-memory relay (fast path)
 * and the `runtime-state.json` sidecar (survives kill -9). Answering from
 * either store removes it from both, so a question is never re-delivered.
 *
 * 2.1.4 surface: agent questions arrive as session forms (`form.created`,
 * `GET /session/:id/form`, `POST .../form/:formID/reply`) and permissions
 * as session-scoped requests (`GET /session/:id/permission`,
 * `POST .../permission/:requestID/reply`). There is no `question.*` HTTP
 * endpoint; free-text prompts are only the fallback when a form is gone.
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

/**
 * Map a free-text/option response onto a form answer. Option-like fields
 * match by value, label, or 1-based position (the rendered form numbers
 * options); anything else goes in as free text on the first field.
 */
export function mapResponseToFormAnswer(
  fields: Array<{ key: string; options?: Array<{ value: string; label: string }> }>,
  response: string,
): Record<string, unknown> {
  const first = fields[0];
  if (!first) return {};
  const want = response.trim();
  const options = first.options ?? [];
  const byIndex = /^\d+$/.test(want) ? options[Number.parseInt(want, 10) - 1] : undefined;
  const byValue = options.find(
    (o) => o.value.toLowerCase() === want.toLowerCase() || o.label.toLowerCase() === want.toLowerCase(),
  );
  return { [first.key]: byIndex?.value ?? byValue?.value ?? response };
}

/**
 * Answer a pending V2 form (the agent question-tool surface on 2.1.4).
 * Returns the form ID on success, null when there is no pending form.
 * Throws only when a form exists but the reply itself fails.
 */
export async function answerViaForm(
  port: number,
  sessionID: string,
  partId: string,
  response: string,
): Promise<string | null> {
  if (!partId.startsWith('frm_')) return null;
  const config = await loadConfig();
  const client = createV2Client(port, config.serverPassword);
  const form = await v2GetForm(client, sessionID, partId);
  if (form.state.status !== 'pending') return null;
  await v2ReplyForm(client, sessionID, partId, mapResponseToFormAnswer(form.fields, response));
  return partId;
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
    const formID = await answerViaForm(live.port, live.remoteSessionID, live.partId, response).catch(() => null);
    if (!formID) {
      await sender(live.port, live.remoteSessionID, response);
    }
    removePendingQuestion(live.jobId, live.partId);
    await dropPersistedQuestion(live.jobId, live.partId);
    return formID
      ? `Answer sent to job "${jobName}" (form reply): "${response}"`
      : `Answer sent to job "${jobName}": "${response}"`;
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
  const formID = await answerViaForm(q.port, q.remoteSessionID, q.partId, response).catch(() => null);
  if (!formID) {
    await sender(q.port, q.remoteSessionID, response);
  }
  await dropPersistedQuestion(q.jobId, q.partId);
  return formID
    ? `Answer sent to job "${jobName}" (form reply, from durable sidecar): "${response}"`
    : `Answer sent to job "${jobName}" (from durable sidecar): "${response}"`;
}
