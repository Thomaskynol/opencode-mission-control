/**
 * Lane C — a permissão invisível (Achado 3 M4).
 *
 * O SSE é volátil por contrato (overflow/desconexão perde eventos). No
 * (re)subscribe o monitor recupera SÓ forms (`v2ListForms`); permissões
 * pendentes (`GET /session/:id/permission`) nunca são recuperadas — o
 * worker bloqueia com "[ECC] Permission requires user approval" no pane
 * enquanto `questions`/`follow` mostram "none".
 *
 * RED: `v2ListPermissions` existe no SDK mas o monitor nunca a chama.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Job } from '../../src/lib/job-state';
import * as configMod from '../../src/lib/config';
import * as planStateMod from '../../src/lib/plan-state';
import * as sdkClientMod from '../../src/lib/sdk-client';
import * as paths from '../../src/lib/paths';
import {
  getPendingQuestionsForJob,
  clearPendingQuestionsForJob,
} from '../../src/lib/question-relay';
import { listPersistedQuestions } from '../../src/lib/durable-state';
import { JobMonitor } from '../../src/lib/monitor';

let testBaseDir = '';
let testStateDir = '';
let restoreDataDir = () => {};

function baseJob(): Job {
  return {
    id: 'job-backfill',
    name: 'backfill-job',
    worktreePath: '/tmp/wt-backfill',
    branch: 'main',
    tmuxTarget: 'mc-backfill',
    placement: 'session',
    status: 'running',
    prompt: 'Do backfill work',
    mode: 'vanilla',
    createdAt: new Date().toISOString(),
    port: 18991,
    remoteSessionID: 'ses_backfill',
  };
}

const unseenPermission = {
  id: 'perm-unseen-1',
  sessionID: 'ses_backfill',
  action: 'shell',
  resources: ['/tmp/outside/run.sh'],
  message: 'run outside command',
};

beforeEach(async () => {
  const fs = await import('fs');
  testBaseDir = await fs.promises.mkdtemp(join(tmpdir(), 'mc-lanec-backfill-'));
  testStateDir = join(testBaseDir, 'state');
  fs.mkdirSync(testStateDir, { recursive: true });
  const spy = spyOn(paths, 'getDataDir').mockResolvedValue(testStateDir);
  restoreDataDir = () => spy.mockRestore();

  (globalThis as any).__testGlobalPolicy = undefined;
  (globalThis as any).__testPlan = null;
  spyOn(configMod, 'loadConfig').mockImplementation(
    async () => ({ defaultPermissionPolicy: (globalThis as any).__testGlobalPolicy }) as any,
  );
  spyOn(planStateMod, 'loadPlan').mockImplementation(async () => (globalThis as any).__testPlan);
});

afterEach(async () => {
  mock.restore();
  clearPendingQuestionsForJob('job-backfill');
  restoreDataDir();
  const fs = await import('fs');
  if (testBaseDir && fs.existsSync(testBaseDir)) {
    fs.rmSync(testBaseDir, { recursive: true, force: true });
  }
  testBaseDir = '';
});

describe('permission backfill — unseen permission becomes operator-visible', () => {
  it('registers a listed-but-unseen permission as pending (memory + sidecar)', async () => {
    spyOn(sdkClientMod, 'v2ListForms').mockResolvedValue([]);
    const listPerms = spyOn(sdkClientMod, 'v2ListPermissions').mockResolvedValue([unseenPermission] as never);
    const monitor = new JobMonitor();
    try {
      // No SSE event ever arrived for this permission (stream gap). The
      // backfill runs on subscribe with the live client.
      await (monitor as any).backfillPendingQuestions(baseJob(), {} as never);

      expect(listPerms).toHaveBeenCalledTimes(1);
      const pending = getPendingQuestionsForJob('job-backfill');
      expect(pending.map((q) => q.partId)).toContain('perm:perm-unseen-1');
      const sidecar = await listPersistedQuestions();
      expect(sidecar.filter((q) => q.partId === 'perm:perm-unseen-1')).toHaveLength(1);
    } finally {
      monitor.stop();
    }
  });

  it('fail-closed: policy/load error escalates instead of dropping the permission', async () => {
    // loadConfig throws AFTER the permission was built → the event path
    // must escalate as ask-user, never silently drop a blocked worker.
    // NOTE: mock.restore() also drops the beforeEach spies, so every
    // isolation spy (XDG included) is re-applied here — a test must never
    // touch the real sidecar.
    mock.restore();
    const fs = await import('fs');
    const dirSpy = spyOn(paths, 'getDataDir').mockResolvedValue(testStateDir);
    spyOn(configMod, 'loadConfig').mockRejectedValue(new Error('config exploded') as never);
    spyOn(planStateMod, 'loadPlan').mockResolvedValue(null);
    const seen: string[] = [];
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = (async (url: unknown) => {
      seen.push(String(url));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const monitor = new JobMonitor({ pollInterval: 10000, idleThreshold: 300000 });
    try {
      await (monitor as any).handlePermissionUpdate(baseJob(), {
        properties: {
          id: 'perm-err-1',
          type: 'shell',
          path: '/tmp/outside/run.sh',
          description: 'run outside command',
        },
      });
      // Escalated: visible as pending…
      expect(getPendingQuestionsForJob('job-backfill').map((q) => q.partId)).toContain('perm:perm-err-1');
      const sidecar = await listPersistedQuestions();
      expect(sidecar.filter((q) => q.partId === 'perm:perm-err-1')).toHaveLength(1);
      // …and NOT decided on the wire (no approve/reject reply sent).
      expect(seen.filter((u) => u.includes('/permission/perm-err-1/reply'))).toHaveLength(0);
      (monitor as any).questionRelay.dispose();
    } finally {
      globalThis.fetch = origFetch;
      monitor.stop();
      dirSpy.mockRestore();
    }
  });
});
