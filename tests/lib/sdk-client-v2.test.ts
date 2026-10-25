import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  createV2Client,
  quoteShellPath,
  v2CreateSession,
  v2GetSession,
  v2Interrupt,
  v2ListForms,
  v2ListPermissions,
  v2ReplyForm,
  v2ReplyPermission,
  v2WaitForServer,
} from '../../src/lib/sdk-client';

const realFetch = globalThis.fetch;

function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
  globalThis.fetch = (async (url: unknown, init?: unknown) =>
    handler(String(url), init as RequestInit)) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('v2 client', () => {
  beforeEach(() => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }),
    );
  });

  it('points at the /api prefix and sets basic auth when a password is given', async () => {
    let seenUrl = '';
    let seenAuth = '';
    stubFetch((url, init) => {
      seenUrl = url;
      seenAuth = String((init?.headers as Record<string, string>)?.['Authorization'] ?? '');
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    });

    await v2GetSession(createV2Client(17891, 's3cret'), 'ses_1');

    expect(seenUrl).toBe('http://127.0.0.1:17891/api/session/ses_1');
    expect(seenAuth).toBe('Basic ' + Buffer.from('opencode:s3cret').toString('base64'));
  });

  it('sends no auth header without a password', async () => {
    let seenAuth: unknown = 'present';
    stubFetch((_url, init) => {
      seenAuth = (init?.headers as Record<string, string>)?.['Authorization'];
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    });

    await v2GetSession(createV2Client(17891), 'ses_1');
    expect(seenAuth).toBeUndefined();
  });

  it('creates a session with the pinned profile body', async () => {
    let seenBody: Record<string, unknown> = {};
    stubFetch((_url, init) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ data: { id: 'ses_9' } }), { status: 200 });
    });

    const info = await v2CreateSession(createV2Client(17891), {
      agent: 'build',
      model: { providerID: 'anthropic', id: 'claude-sonnet-4-20250514' },
      location: { directory: '/tmp/m2-work' },
      permissions: [{ action: 'edit', resource: '/tmp/**', effect: 'allow' }],
    });

    expect(info.id).toBe('ses_9');
    expect(seenBody).toEqual({
      agent: 'build',
      model: { providerID: 'anthropic', id: 'claude-sonnet-4-20250514' },
      location: { directory: '/tmp/m2-work' },
      permissions: [{ action: 'edit', resource: '/tmp/**', effect: 'allow' }],
    });
  });

  it('throws without leaking credentials on HTTP errors', async () => {
    stubFetch(() => new Response('{"error":"nope"}', { status: 401 }));
    const err = await v2GetSession(createV2Client(17891, 's3cret'), 'ses_1').catch(
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/401/);
    expect(err.message).not.toMatch(/s3cret/);
  });

  it('throws when the data envelope is missing', async () => {
    stubFetch(() => new Response('{"unexpected":true}', { status: 200 }));
    await expect(v2GetSession(createV2Client(17891), 'ses_1')).rejects.toThrow(
      /data envelope/,
    );
  });

  it('passes through non-enveloped responses (interrupt) and empty 204s', async () => {
    stubFetch(() => new Response('{"interrupted":false}', { status: 200 }));
    await expect(v2Interrupt(createV2Client(17891), 'ses_1')).resolves.toEqual({
      interrupted: false,
    });

    stubFetch(() => new Response('', { status: 204 }));
    await expect(v2Interrupt(createV2Client(17891), 'ses_1')).resolves.toBeUndefined();
  });
});

describe('v2 readiness', () => {
  it('polls /api/info until the server answers and returns an authed client', async () => {
    let calls = 0;
    let seenAuth = '';
    stubFetch((_url, init) => {
      calls += 1;
      seenAuth = String((init?.headers as Record<string, string>)?.['Authorization'] ?? '');
      if (calls < 3) return new Response('down', { status: 503 });
      return new Response('{"version":"2.1.4"}', { status: 200 });
    });

    const client = await v2WaitForServer(17891, { timeoutMs: 5000, password: 's3cret' });
    expect(client.baseUrl).toBe('http://127.0.0.1:17891/api');
    expect(calls).toBe(3);
    expect(seenAuth).toBe('Basic ' + Buffer.from('opencode:s3cret').toString('base64'));
  });

  it('times out with the port when the server never answers', async () => {
    stubFetch(() => new Response('down', { status: 503 }));
    await expect(v2WaitForServer(17891, { timeoutMs: 300 })).rejects.toThrow(/17891/);
  });
});

describe('v2 forms (question surface)', () => {
  it('lists pending forms for a session', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ data: [{ id: 'frm_1', sessionID: 'ses_1', title: 'Q', fields: [] }] }),
          { status: 200 },
        ),
    );
    const forms = await v2ListForms(createV2Client(17891), 'ses_1');
    expect(forms).toHaveLength(1);
    expect(forms[0].id).toBe('frm_1');
  });

  it('replies with a field-keyed answer object', async () => {
    let seenBody: Record<string, unknown> = {};
    stubFetch((_url, init) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('', { status: 204 });
    });

    await v2ReplyForm(createV2Client(17891), 'ses_1', 'frm_1', { q0: 'Red' });
    expect(seenBody).toEqual({ answer: { q0: 'Red' } });
  });

  it('quotes shell paths with spaces and single quotes', () => {
    expect(quoteShellPath('/tmp/my dir/launch.sh')).toBe("'/tmp/my dir/launch.sh'");
    expect(quoteShellPath("/tmp/o'clock/launch.sh")).toBe("'/tmp/o'\\''clock/launch.sh'");
  });
});

describe('v2 permissions (session-scoped reply)', () => {
  it('lists pending permission requests for a session', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [{ id: 'per_1', sessionID: 'ses_1', action: 'read', resources: ['/etc/x'] }],
          }),
          { status: 200 },
        ),
    );
    const reqs = await v2ListPermissions(createV2Client(17891), 'ses_1');
    expect(reqs[0].id).toBe('per_1');
  });

  it('replies once/reject on the session-scoped endpoint', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    stubFetch((url, init) => {
      seen.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response('', { status: 204 });
    });

    const client = createV2Client(17891);
    await v2ReplyPermission(client, 'ses_1', 'per_1', 'once', 'Approved');
    await v2ReplyPermission(client, 'ses_1', 'per_2', 'reject', 'Denied');

    expect(seen[0].url).toBe('http://127.0.0.1:17891/api/session/ses_1/permission/per_1/reply');
    expect(seen[0].body).toEqual({ decision: 'once', message: 'Approved' });
    expect(seen[1].body).toEqual({ decision: 'reject', message: 'Denied' });
  });
});
