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
  v2ReplyPermission,
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
  const isPermission = q.partId.startsWith('perm:');
  const lines = [
    `${isPermission ? '🔐' : '❓'} Job "${q.jobName}" ${isPermission ? 'needs a permission decision:' : 'asks:'}`,
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
  if (isPermission) {
    lines.push(
      `Reply with "approve"/"1" (once) or "deny"/"2" (reject).`,
      // Fail-closed: the relay timeout DENIES every permission category —
      // silence never approves. The question-tool path (non-permissions)
      // is the only one that auto-resolves with best judgment.
      `No reply within ${QUESTION_AUTO_RESPONSE_MS / 1000}s → DENIED by policy (silence never approves).`,
      `Other jobs keep running meanwhile. Answer via: answer ${q.jobName} <approve|deny>`,
    );
  } else {
    lines.push(
      `Reply with the option number/label, or free-text instructions.`,
      `No reply within ${QUESTION_AUTO_RESPONSE_MS / 1000}s → "${QUESTION_DEFAULT_RESPONSE}".`,
      `Other jobs keep running meanwhile.`,
    );
  }
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
 * Answer a permission escalation (`perm:<id>`) via the session-scoped
 * permission reply endpoint. Fail-closed: only explicit positive
 * approve/deny tokens (PT+EN) send a decision (`once`/`reject`);
 * empty, questions, "aguarde" and any ambiguous text never approve —
 * they throw a clarification error without touching the network.
 * Returns true when a permission reply was sent.
 */
const PERM_APPROVE = new Set([
  '1', 'approve', 'approved', 'yes', 'y', 'yeah', 'yep', 'allow', 'allowed',
  'once', 'always', 'sim', 's', 'autorizo', 'autorizado', 'aprovado', 'aprovar',
  'aprove', 'permitir', 'permitido', 'confirmar', 'confirmo', 'liberado', 'liberar', 'ok',
]);
const PERM_DENY = new Set([
  '2', 'deny', 'denied', 'no', 'n', 'nope', 'reject', 'rejected',
  'nao', 'nunca', 'nego', 'negar', 'negado', 'negada', 'recuso', 'recusar',
  'recusado', 'rejeito', 'rejeitar', 'rejeitado', 'cancelar', 'cancelado',
  'cancela', 'proibo', 'proibido', 'nao autorizo', 'nao permito', 'nao aprovo',
]);
// Multi-word deny intent inside a longer sentence (word-boundaried, never approves).
const PERM_DENY_PHRASE = /\b(nao\s+autorizo|nao\s+permito|nao\s+aprovo|deny|rejected?)\b/;

function normalizePerm(text: string): string {
  return text.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
}

export async function answerViaPermission(
  port: number,
  sessionID: string,
  partId: string,
  response: string,
): Promise<boolean> {
  if (!partId.startsWith('perm:')) return false;
  if (!port || !sessionID) return false;
  const permissionId = partId.slice('perm:'.length);
  const want = normalizePerm(response ?? '');
  if (!want) {
    throw new Error(
      'Clarification needed: empty response never approves. Reply with explicit "approve"/"sim" (once) or "deny"/"não" (reject).',
    );
  }
  if (want.endsWith('?')) {
    throw new Error(
      'Clarification needed: questions never approve. Reply with explicit "approve"/"sim" (once) or "deny"/"não" (reject), or "aguarde" to keep waiting (no decision sent).',
    );
  }
  let approved: boolean;
  let message: string;
  if (PERM_APPROVE.has(want)) {
    approved = true;
    message = 'Approved by operator (once)';
  } else if (PERM_DENY.has(want)) {
    approved = false;
    message = 'Denied by operator';
  } else if (PERM_DENY_PHRASE.test(want)) {
    approved = false;
    message = response;
  } else {
    // Unknown/ambiguous (incl. "aguarde", free-text): never approve, never deny by silence.
    throw new Error(
      `Clarification needed: "${response}" is not an explicit approve/deny. Reply with "approve"/"sim" (once) or "deny"/"não" (reject); "aguarde" keeps waiting without sending a decision.`,
    );
  }
  const config = await loadConfig();
  const client = createV2Client(port, config.serverPassword);
  await v2ReplyPermission(client, sessionID, permissionId, approved ? 'once' : 'reject', message);
  return true;
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
    if (live.partId.startsWith('perm:')) {
      try {
        await answerViaPermission(live.port, live.remoteSessionID, live.partId, response);
      } catch (e) {
        // Clarification never sends and never drops the question.
        if (e instanceof Error && /clarification needed/i.test(e.message)) throw e;
        removePendingQuestion(live.jobId, live.partId);
        await dropPersistedQuestion(live.jobId, live.partId);
        return `Permission "${live.partId}" recorded for job "${jobName}" (worker offline — decision visible in overview)`;
      }
      removePendingQuestion(live.jobId, live.partId);
      await dropPersistedQuestion(live.jobId, live.partId);
      return `Permission decision sent to job "${jobName}": "${response}"`;
    }
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
  if (q.partId.startsWith('perm:')) {
    try {
      await answerViaPermission(q.port, q.remoteSessionID, q.partId, response);
    } catch (e) {
      if (e instanceof Error && /clarification needed/i.test(e.message)) throw e;
      await dropPersistedQuestion(q.jobId, q.partId);
      return `Permission "${q.partId}" recorded for job "${jobName}" (from durable sidecar, worker offline)`;
    }
    await dropPersistedQuestion(q.jobId, q.partId);
    return `Permission decision sent to job "${jobName}" (from durable sidecar): "${response}"`;
  }
  const formID = await answerViaForm(q.port, q.remoteSessionID, q.partId, response).catch(() => null);
  if (!formID) {
    await sender(q.port, q.remoteSessionID, response);
  }
  await dropPersistedQuestion(q.jobId, q.partId);
  return formID
    ? `Answer sent to job "${jobName}" (form reply, from durable sidecar): "${response}"`
    : `Answer sent to job "${jobName}" (from durable sidecar): "${response}"`;
}
