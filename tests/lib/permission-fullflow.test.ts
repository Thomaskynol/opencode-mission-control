/**
 * Lane C — fluxo completo da permissão (pedido → questions → resposta → retomada).
 *
 * Prova fail-closed de ponta a ponta com o caminho público:
 * 1. pedido: QuestionRelay.handlePermissionRequest escala shell fora do worktree;
 * 2. exibição: `questions` (listQuestionForms) mostra o pedido vindo do sidecar;
 * 3. resposta: answerQuestion(job,'approve') envia `once` e limpa ambas as lojas;
 * 4. silêncio/ambiguidade ('aguarde', vazio) NUNCA aprova: sem envio, pendência mantida.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import * as paths from '../../src/lib/paths';
import {
  QuestionRelay,
  getPendingQuestionsForJob,
  clearPendingQuestionsForJob,
} from '../../src/lib/question-relay';
import { loadRuntimeSnapshot } from '../../src/lib/durable-state';
import { answerQuestion } from '../../src/orchestrator-cli/forms';
import { listQuestionForms } from '../../src/orchestrator-cli/commands';
import type { Job } from '../../src/lib/job-state';

let testBaseDir = '';
let testStateDir = '';
let restoreDataDir = () => {};
let origFetch: typeof fetch;
let seen: Array<{ url: string; body: string }>;

function mkJob(): Job {
  return {
    id: 'job-fullflow',
    name: 'fullflow-job',
    worktreePath: '/tmp/wt-fullflow',
    branch: 'main',
    tmuxTarget: 'mc-fullflow',
    placement: 'session',
    status: 'running',
    prompt: 'fullflow probe task',
    mode: 'vanilla',
    createdAt: new Date().toISOString(),
    port: 18992,
    remoteSessionID: 'ses_fullflow',
  };
}

beforeEach(async () => {
  const fs = await import('fs');
  testBaseDir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-lanec-fullflow-'));
  testStateDir = join(testBaseDir, 'state');
  fs.mkdirSync(testStateDir, { recursive: true });
  const spy = spyOn(paths, 'getDataDir').mockResolvedValue(testStateDir);
  restoreDataDir = () => spy.mockRestore();

  seen = [];
  origFetch = globalThis.fetch;
  (globalThis as any).fetch = (async (url: unknown, init?: unknown) => {
    seen.push({ url: String(url), body: JSON.stringify((init as any)?.body ?? {}) });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = origFetch;
  mock.restore();
  clearPendingQuestionsForJob('job-fullflow');
  restoreDataDir();
  const fs = await import('fs');
  if (testBaseDir && fs.existsSync(testBaseDir)) {
    fs.rmSync(testBaseDir, { recursive: true, force: true });
  }
  testBaseDir = '';
});

function replyFor(permissionId: string) {
  return seen.find((s) => s.url.includes(permissionId));
}

describe('permission full flow — request → questions → answer → resume', () => {
  it('escalation is visible in `questions` and explicit approve resumes (once)', async () => {
    const relay = new QuestionRelay({ autoResponseTimeoutMs: 60_000 });
    try {
      const result = await relay.handlePermissionRequest(mkJob(), {
        id: 'perm-flow-1',
        type: 'shell_command',
        path: '/tmp/outside/run.sh',
        description: 'run outside command',
      }, undefined, 'ask-user');
      expect(result.autoApproved).toBe(false);

      // 2. exibição: o operador vê o pedido via caminho público.
      const forms = await listQuestionForms();
      expect(forms).toContain('fullflow-job');
      expect(forms).toContain('run outside command');

      // 3. resposta humana explícita → retomada (once) + limpeza total.
      const out = await answerQuestion('fullflow-job', 'approve', async () => {
        throw new Error('sender fallback must not run for perm: questions');
      });
      expect(out).toMatch(/Permission decision sent/);
      const call = replyFor('perm-flow-1');
      expect(call).toBeDefined();
      expect(call!.body).toMatch(/once/);
      expect(getPendingQuestionsForJob('job-fullflow')).toHaveLength(0);
      const sidecar = await loadRuntimeSnapshot();
      expect(sidecar?.pendingQuestions ?? []).toHaveLength(0);
    } finally {
      relay.dispose();
    }
  });

  it('silence/ambiguity NEVER approves: aguarde/vazio mantêm a pendência sem enviar nada', async () => {
    const relay = new QuestionRelay({ autoResponseTimeoutMs: 60_000 });
    try {
      await relay.handlePermissionRequest(mkJob(), {
        id: 'perm-flow-2',
        type: 'shell_command',
        path: '/tmp/outside/run.sh',
        description: 'run outside command',
      }, undefined, 'ask-user');

      for (const ambiguous of ['aguarde', '', '   ', 'como devo proceder?']) {
        await expect(
          answerQuestion('fullflow-job', ambiguous, async () => {}),
        ).rejects.toThrow(/clarification/i);
      }
      // Nada enviado, pendência intacta nos dois lados.
      expect(seen.filter((s) => s.url.includes('/permission/'))).toHaveLength(0);
      expect(getPendingQuestionsForJob('job-fullflow').map((q) => q.partId)).toContain('perm:perm-flow-2');
      const sidecar = await loadRuntimeSnapshot();
      expect((sidecar?.pendingQuestions ?? []).map((q) => q.partId)).toContain('perm:perm-flow-2');
    } finally {
      relay.dispose();
    }
  });
});
