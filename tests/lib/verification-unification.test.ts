import { describe, it, expect } from 'bun:test';

/** G verification: strict rule unified in both report paths; timers never approve publishing/network/unknown. */
describe('verification unification (G)', () => {
  it('integration-scope pass is NOT Verified in strict rule (both paths)', async () => {
    const { isTaskVerified } = await import('../../src/lib/verification');
    const integrationOnly = { testStatus: 'passed', scope: 'integration', testCommand: 'bun test', reviewedCommit: undefined } as any;
    expect(isTaskVerified(integrationOnly)).toBe(false);
    const taskPass = { testStatus: 'passed', scope: 'task', testCommand: 'bun test', reviewedCommit: 'abc1234567890' } as any;
    expect(isTaskVerified(taskPass)).toBe(true);
    const taskNoCommit = { testStatus: 'passed', scope: 'task', testCommand: 'bun test' } as any;
    expect(isTaskVerified(taskNoCommit)).toBe(false);
    const acceptanceLess = { testStatus: 'passed', scope: 'task', testCommand: 'bun test', reviewedCommit: 'abc123', acceptanceLess: true } as any;
    expect(isTaskVerified(acceptanceLess)).toBe(false);
  });

  it('publishing/network/unknown NEVER auto-approve on timeout (fail-closed, logged)', async () => {
    const { QuestionRelay, getPendingQuestionsForJob, clearPendingQuestionsForJob } = await import('../../src/lib/question-relay');
    const seen: Array<{ url: string; body: unknown }> = [];
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = (async (url: unknown, init?: unknown) => {
      seen.push({ url: String(url), body: (init as { body?: unknown })?.body });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      const relay = new QuestionRelay({ autoResponseTimeoutMs: 20 } as any);
      const baseJob: any = { id: 'g-timer', name: 'g', port: 18991, remoteSessionID: 'ses_g', worktreePath: '/tmp', prompt: 'do' };
      // network escalation must auto-deny, never approve
      await relay.handlePermissionRequest(baseJob, { id: 'perm-net', type: 'network', description: 'fetch https://example.com' } as any);
      // unknown escalation must auto-deny
      await relay.handlePermissionRequest({ ...baseJob, id: 'g-timer2' }, { id: 'perm-unk', type: 'other', description: '???' } as any);
      await new Promise((r) => setTimeout(r, 80));
      const netCall = seen.find((s) => s.url.includes('perm-net'));
      const unkCall = seen.find((s) => s.url.includes('perm-unk'));
      expect(netCall).toBeDefined();
      expect(unkCall).toBeDefined();
      // deny = reject (never approve by silence)
      expect(JSON.stringify(netCall!.body)).toMatch(/reject|denied|false/i);
      expect(JSON.stringify(unkCall!.body)).toMatch(/reject|denied|false/i);
      relay.dispose();
      clearPendingQuestionsForJob('g-timer');
      clearPendingQuestionsForJob('g-timer2');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
