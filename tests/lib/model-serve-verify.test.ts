import { describe, it, expect, afterEach } from 'vitest';

import {
  assertServeSessionModelEcho,
  createV2Client,
  launchWorkerViaServe,
  v2CreateSessionWithVerifiedModel,
  v2RunCommand,
} from '../../src/lib/sdk-client';

const realFetch = globalThis.fetch;

function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = (async (url: unknown, init?: unknown) =>
    handler(String(url), init as RequestInit)) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

function sessionPayload(id: string, model: unknown): string {
  return JSON.stringify({ data: { id, model } });
}

const WANT = {
  providerID: 'opencode-go',
  id: 'muse-spark-1.3-contributor',
  variant: 'xhigh',
};

describe('v2 serve session with verified model (R03 observable pin)', () => {
  it('echo mode (default): POST carries the full triple and the echo matches with no extra GET', async () => {
    const seen: Array<{ url: string; body?: unknown }> = [];
    stubFetch((url, init) => {
      seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(
        sessionPayload('ses_1', {
          providerID: 'opencode-go',
          id: 'muse-spark-1.3-contributor',
          variant: 'xhigh',
        }),
        { status: 200 },
      );
    });

    const info = await v2CreateSessionWithVerifiedModel(createV2Client(17891), {
      model: { ...WANT },
      location: { directory: '/tmp/mc-w' },
    });

    expect(info.id).toBe('ses_1');
    // Variant rides the POST body (launch.ts used to drop it here).
    const post = seen.find((s) => s.url.endsWith('/api/session'));
    expect(post?.body).toMatchObject({ model: { ...WANT } });
    // Echo verified with zero extra calls (mock-compatible seam).
    expect(seen.every((s) => !s.url.includes('/ses_1'))).toBe(true);
  });

  it('echo mode: a present-but-different echo throws fail-closed', async () => {
    stubFetch(() =>
      new Response(sessionPayload('ses_2', { providerID: 'opencode-go', id: 'other-model' }), {
        status: 200,
      }),
    );

    await expect(
      v2CreateSessionWithVerifiedModel(createV2Client(17891), { model: { ...WANT } }),
    ).rejects.toThrow(/model mismatch/);
  });

  it('echo mode: an absent echo fails closed (a requested pin must be observed)', async () => {
    let gets = 0;
    stubFetch((url) => {
      if (!url.endsWith('/api/session')) gets += 1;
      return new Response(sessionPayload('ses_3', undefined), { status: 200 });
    });

    // Absence is observable on real servers (2.2.5 omits `model` when no pin
    // was sent), so it can never count as a verified pin — not even for
    // mock compatibility. Mocks must echo the triple they receive.
    await expect(
      v2CreateSessionWithVerifiedModel(createV2Client(17891), {
        model: { ...WANT },
      }),
    ).rejects.toThrow(/model absent|model mismatch/);
    expect(gets).toBe(0);
  });

  it('get mode: an absent model on the GET round-trip fails closed', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/api/session') && init?.method === 'POST') {
        return new Response(sessionPayload('ses_3', undefined), { status: 200 });
      }
      return new Response(sessionPayload('ses_3', undefined), { status: 200 });
    });

    await expect(
      v2CreateSessionWithVerifiedModel(
        createV2Client(17891),
        { model: { ...WANT } },
        'get',
      ),
    ).rejects.toThrow(/model absent|model mismatch/);
  });

  it('get mode: verifies the triple back via GET /session/:id', async () => {
    const seen: string[] = [];
    stubFetch((url, init) => {
      seen.push(url);
      if (url.endsWith('/api/session') && init?.method === 'POST') {
        return new Response(sessionPayload('ses_1', { ...WANT }), { status: 200 });
      }
      return new Response(sessionPayload('ses_1', { ...WANT }), { status: 200 });
    });

    const info = await v2CreateSessionWithVerifiedModel(
      createV2Client(17891),
      { model: { ...WANT } },
      'get',
    );
    expect(info.id).toBe('ses_1');
    expect(seen.some((s) => s.endsWith('/api/session/ses_1'))).toBe(true);
    expect(info.model).toMatchObject({ variant: 'xhigh' });
  });

  it('get mode: fails closed when the server reports a different triple', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/api/session') && init?.method === 'POST') {
        return new Response(sessionPayload('ses_2', { providerID: 'x', id: 'y' }), {
          status: 200,
        });
      }
      return new Response(
        sessionPayload('ses_2', { providerID: 'opencode-go', id: 'other-model' }),
        { status: 200 },
      );
    });

    await expect(
      v2CreateSessionWithVerifiedModel(createV2Client(17891), { model: { ...WANT } }, 'get'),
    ).rejects.toThrow(/model mismatch/);
  });

  it('skips verification when no model was requested', async () => {
    let gets = 0;
    stubFetch((url) => {
      if (url.endsWith('/api/session/ses_3')) gets += 1;
      return new Response(sessionPayload('ses_3', undefined), { status: 200 });
    });

    for (const mode of ['echo', 'get'] as const) {
      const info = await v2CreateSessionWithVerifiedModel(
        createV2Client(17891),
        { location: { directory: '/tmp/mc-w' } },
        mode,
      );
      expect(info.id).toBe('ses_3');
    }
    expect(gets).toBe(0);
  });
});

describe('assertServeSessionModelEcho (pure)', () => {
  it('accepts a matching echo and rejects a different one', () => {
    expect(() =>
      assertServeSessionModelEcho(
        { id: 's', projectID: 'p', location: { directory: '/w' }, model: { ...WANT } },
        WANT,
      ),
    ).not.toThrow();
    expect(() =>
      assertServeSessionModelEcho(
        {
          id: 's',
          projectID: 'p',
          location: { directory: '/w' },
          model: { providerID: 'opencode-go', id: 'other' },
        },
        WANT,
      ),
    ).toThrow(/model mismatch/);
  });

  it('rejects an absent echo even though no mismatch string exists to compare', () => {
    expect(() =>
      assertServeSessionModelEcho(
        { id: 's', projectID: 'p', location: { directory: '/w' } },
        WANT,
      ),
    ).toThrow(/model absent/);
  });

  it("treats the server-canonical 'default' variant as no-pin (2.2.5 native), but not as a pinned variant", () => {
    const noPin = { providerID: 'opencode-go', id: 'muse-spark-1.3-contributor' };
    // Pin without variant vs server echo variant:"default" → verified.
    expect(() =>
      assertServeSessionModelEcho(
        {
          id: 's',
          projectID: 'p',
          location: { directory: '/w' },
          model: { providerID: 'opencode-go', id: 'muse-spark-1.3-contributor', variant: 'default' },
        },
        noPin,
      ),
    ).not.toThrow();
    // Explicitly pinned #xhigh vs server "default" → still fail-closed.
    expect(() =>
      assertServeSessionModelEcho(
        {
          id: 's',
          projectID: 'p',
          location: { directory: '/w' },
          model: { providerID: 'opencode-go', id: 'muse-spark-1.3-contributor', variant: 'default' },
        },
        WANT,
      ),
    ).toThrow(/model mismatch/);
  });
});

describe('launchWorkerViaServe (reusable autonomous entry, integrador)', () => {
  it('POST carries the full triple with variant, prompts, and returns the handle with no extra GET', async () => {
    const seen: Array<{ url: string; method: string; body?: unknown }> = [];
    stubFetch((url, init) => {
      seen.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/api/session/ses_9/prompt')) {
        return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
      }
      return new Response(
        sessionPayload('ses_9', {
          providerID: 'opencode-go',
          id: 'muse-spark-1.3-contributor',
          variant: 'xhigh',
        }),
        { status: 200 },
      );
    });

    const handle = await launchWorkerViaServe(createV2Client(17891), {
      worktree: '/tmp/mc-w',
      prompt: 'do the work',
      model: { ...WANT },
      profile: { permissions: [{ action: 'read', resource: '/tmp/mc-w/**', effect: 'allow' }] },
      tmuxTarget: 'mc-work',
    });

    expect(handle.sessionId).toBe('ses_9');
    expect(handle.tmuxTarget).toBe('mc-work');
    // Requested vs observed stay separate fields: the observed triple is the
    // server echo, never the request repackaged.
    expect(handle.requestedModel).toMatchObject({ variant: 'xhigh' });
    expect(handle.observedModel).toMatchObject({
      providerID: 'opencode-go',
      id: 'muse-spark-1.3-contributor',
      variant: 'xhigh',
    });
    const post = seen.find((s) => s.url.endsWith('/api/session') && s.method === 'POST');
    expect(post?.body).toMatchObject({
      model: { ...WANT },
      location: { directory: '/tmp/mc-w' },
    });
    const promptCall = seen.find((s) => s.url.endsWith('/api/session/ses_9/prompt'));
    expect(promptCall?.body).toMatchObject({ text: 'do the work' });
    // Echo mode: exactly POST session + POST prompt, no verification GET.
    expect(seen.filter((s) => s.method === 'GET')).toHaveLength(0);
    expect(seen).toHaveLength(2);
  });

  it('mismatch rejects before the prompt is sent (fail-closed, no extra calls)', async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      if (url.endsWith('/api/session/ses_9/prompt')) {
        return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
      }
      return new Response(sessionPayload('ses_9', { providerID: 'opencode-go', id: 'other-model' }), {
        status: 200,
      });
    });

    await expect(
      launchWorkerViaServe(createV2Client(17891), {
        worktree: '/tmp/mc-w',
        prompt: 'do the work',
        model: { ...WANT },
        profile: { permissions: [{ action: 'read', resource: '/tmp/mc-w/**', effect: 'allow' }] },
      }),
    ).rejects.toThrow(/model mismatch/);
    // Only the session POST happened; the prompt was never delivered.
    expect(seen).toHaveLength(1);
    expect(seen[0].endsWith('/api/session')).toBe(true);
  });

  it("get mode adds exactly one verification GET (POST+GET+prompt, nothing more)", async () => {
    const seen: Array<{ url: string; method: string }> = [];
    stubFetch((url, init) => {
      seen.push({ url, method: init?.method ?? 'GET' });
      if (url.endsWith('/api/session/ses_9/prompt')) {
        return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
      }
      return new Response(sessionPayload('ses_9', { ...WANT }), { status: 200 });
    });

    const handle = await launchWorkerViaServe(createV2Client(17891), {
      worktree: '/tmp/mc-w',
      prompt: 'hi',
      model: { ...WANT },
      verify: 'get',
      profile: { permissions: [{ action: 'read', resource: '/tmp/mc-w/**', effect: 'allow' }] },
    });
    expect(handle.sessionId).toBe('ses_9');
    // POST session + GET session/:id + POST prompt, nothing more.
    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatchObject({ method: 'POST' });
    expect(seen[0].url.endsWith('/api/session')).toBe(true);
    expect(seen[1]).toMatchObject({ method: 'GET' });
    expect(seen[1].url.endsWith('/api/session/ses_9')).toBe(true);
    expect(seen[2].url.endsWith('/api/session/ses_9/prompt')).toBe(true);
  });

  it('never reports the requested pin as observed: no pin, no observed model', async () => {
    stubFetch((url) => {
      if (url.endsWith('/api/session/ses_9/prompt')) {
        return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
      }
      return new Response(sessionPayload('ses_9', undefined), { status: 200 });
    });

    const handle = await launchWorkerViaServe(createV2Client(17891), {
      worktree: '/tmp/mc-w',
      prompt: 'hi',
      profile: { permissions: [{ action: 'read', resource: '/tmp/mc-w/**', effect: 'allow' }] },
    });
    expect(handle.sessionId).toBe('ses_9');
    expect(handle.requestedModel).toBeUndefined();
    expect(handle.observedModel).toBeUndefined();
  });

  it('absent echo with a requested pin rejects before the prompt (nothing to repackage)', async () => {
    const seen: string[] = [];
    stubFetch((url) => {
      seen.push(url);
      if (url.endsWith('/api/session/ses_9/prompt')) {
        return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
      }
      return new Response(sessionPayload('ses_9', undefined), { status: 200 });
    });

    await expect(
      launchWorkerViaServe(createV2Client(17891), {
        worktree: '/tmp/mc-w',
        prompt: 'do the work',
        model: { ...WANT },
        profile: { permissions: [{ action: 'read', resource: '/tmp/mc-w/**', effect: 'allow' }] },
      }),
    ).rejects.toThrow(/model absent/);
    expect(seen).toHaveLength(1);
    expect(seen[0].endsWith('/api/session')).toBe(true);
  });
});

describe('v2RunCommand (serve-native slash-command parity, e.g. /start-work)', () => {
  it('POSTs {name, text} to /session/:id/command for OMO-mode parity without TUI keystrokes', async () => {
    const seen: Array<{ url: string; method: string; body?: unknown }> = [];
    stubFetch((url, init) => {
      seen.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    });

    await v2RunCommand(createV2Client(17891), 'ses_9', '/start-work');

    expect(seen).toHaveLength(1);
    expect(seen[0].url.endsWith('/api/session/ses_9/command')).toBe(true);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].body).toMatchObject({ name: '/start-work' });
  });
});
