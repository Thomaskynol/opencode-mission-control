import { describe, it, expect, afterEach } from 'vitest';

import {
  assertServeSessionModelEcho,
  createV2Client,
  v2CreateSessionWithVerifiedModel,
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

  it('echo mode: an absent echo proceeds (mocks omit it; the POST carried the pin)', async () => {
    let gets = 0;
    stubFetch((url) => {
      if (!url.endsWith('/api/session')) gets += 1;
      return new Response(sessionPayload('ses_3', undefined), { status: 200 });
    });

    const info = await v2CreateSessionWithVerifiedModel(createV2Client(17891), {
      model: { ...WANT },
    });
    expect(info.id).toBe('ses_3');
    expect(gets).toBe(0);
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
});
