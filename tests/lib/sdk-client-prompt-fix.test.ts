import { describe, it, expect, vi, afterEach } from 'vitest';
import * as sdk from '@opencode-ai/sdk';

// Lane FA (fix A sendPrompt): verificação do contrato real do serve 2.2.5.
// NÃO toca tests/lib/sdk-client.test.ts (outro lane): arquivo isolado.
// Fatos verificados live (serve 2.2.5 descartável, porta alta + senha própria):
// - POST /api/session/{id}/prompt {text} -> 200 {data:{id:msg_...}}
// - POST /api/session/{id}/prompt_async -> 404 vazio (extinta)
// - POST /api/session/{id}/message   -> 404 vazio (extinta)
// - GET /session (sem /api) -> 200 text/html SPA (não é JSON)

import {
  createV2Client,
  sendPrompt,
  createSessionAndPrompt,
  forkJobSession,
  waitForServer,
} from '../../src/lib/sdk-client';

const BASE = 'http://127.0.0.1:18999/api';
const AUTH = 'Basic ' + Buffer.from('opencode:test-password-fa').toString('base64');

const realFetch = globalThis.fetch;

interface SeenCall {
  url: string;
  init?: RequestInit;
}

let calls: SeenCall[] = [];

function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
  calls = [];
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return handler(String(url), init as RequestInit);
  }) as typeof fetch;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function headersOf(call: SeenCall): Record<string, string> {
  return (call.init?.headers ?? {}) as Record<string, string>;
}

function header(call: SeenCall, name: string): string | undefined {
  const headers = headersOf(call);
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const found = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return found ? headers[found] : undefined;
}

function fakeLegacyClient(sessionMethods: Record<string, unknown> = {}) {
  // Fiel ao SDK real: getConfig().headers é um Headers (com o
  // Content-Type padrão do SDK já embutido) — o transporte não pode
  // duplicar content-type no fetch (o serve responde 415).
  const headers = new Headers({
    Authorization: AUTH,
    'x-opencode-directory': '/tmp/work',
  });
  headers.append('Content-Type', 'application/json');
  return {
    _client: {
      getConfig: () => ({ baseUrl: BASE, headers }),
    },
    session: {
      promptAsync: vi.fn(),
      prompt: vi.fn(),
      message: vi.fn(),
      create: vi.fn(),
      fork: vi.fn(),
      list: vi.fn(),
      ...sessionMethods,
    },
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('lane FA: sendPrompt via POST /api/session/{id}/prompt', () => {
  it('prompt válido preserva sessão/diretório/auth e retorna o id (cliente legado)', async () => {
    const client = fakeLegacyClient();
    stubFetch(() => jsonResponse({ data: { id: 'msg_fa001' } }));

    const id = await sendPrompt(client as any, 'ses_FA123', 'hello worker');

    expect(id).toBe('msg_fa001');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/session/ses_FA123/prompt`);
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ text: 'hello worker' });
    // auth + diretório preservados no transporte fetch
    expect(header(calls[0], 'Authorization')).toBe(AUTH);
    expect(header(calls[0], 'x-opencode-directory')).toBe('/tmp/work');
    // content-type único (duplicar dá 415 no serve)
    const ctKeys = Object.keys(headersOf(calls[0])).filter((k) => k.toLowerCase() === 'content-type');
    expect(ctKeys).toHaveLength(1);
    expect(headersOf(calls[0])[ctKeys[0]]).toBe('application/json');
  });

  it('prompt válido via V2Client preserva sessão/auth e retorna o id', async () => {
    const client = createV2Client(18999, 'test-password-fa');
    stubFetch(() => jsonResponse({ data: { id: 'msg_fa002' } }));

    const id = await sendPrompt(client as any, 'ses_FA456', 'hi');

    expect(id).toBe('msg_fa002');
    expect(calls[0].url).toBe('http://127.0.0.1:18999/api/session/ses_FA456/prompt');
    expect(header(calls[0], 'Authorization')).toBe(AUTH);
  });

  it('rota extinta nunca é chamada (nem prompt_async nem message do SDK)', async () => {
    const client = fakeLegacyClient();
    stubFetch(() => jsonResponse({ data: { id: 'msg_fa003' } }));

    await sendPrompt(client as any, 'ses_FA123', 'hello');

    expect(client.session.promptAsync).not.toHaveBeenCalled();
    expect(client.session.prompt).not.toHaveBeenCalled();
    expect(client.session.message).not.toHaveBeenCalled();
    expect(calls[0].url).not.toContain('prompt_async');
    expect(calls[0].url).not.toMatch(/\/message$/);
  });

  it('401 propaga erro explícito sem vazar a senha', async () => {
    const client = fakeLegacyClient();
    stubFetch(() => jsonResponse({ _tag: 'UnauthorizedError' }, 401));

    const err = await sendPrompt(client as any, 'ses_FA123', 'hello').catch((e) => e);
    expect(String(err?.message ?? err)).toMatch(/401/);
    expect(String(err?.message ?? err)).not.toContain('test-password-fa');
  });

  it('404 (sessão inexistente) propaga erro explícito', async () => {
    const client = fakeLegacyClient();
    stubFetch(() => jsonResponse({ _tag: 'SessionNotFoundError' }, 404));

    await expect(sendPrompt(client as any, 'ses_nope', 'hello')).rejects.toThrow(/404/);
  });

  it('200 sem envelope {data} propaga erro de schema explícito', async () => {
    const client = fakeLegacyClient();
    stubFetch(() => jsonResponse({ ok: true }));

    await expect(sendPrompt(client as any, 'ses_FA123', 'hello')).rejects.toThrow(
      /data envelope/i,
    );
  });

  it('200 com HTML-SPA (não-JSON) propaga erro explícito', async () => {
    const client = fakeLegacyClient();
    stubFetch(
      () =>
        new Response('<!doctype html><html>spa</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
    );

    await expect(sendPrompt(client as any, 'ses_FA123', 'hello')).rejects.toThrow(/non-JSON/i);
  });

  it('agent/model por prompt falham fechado (pin é na criação da sessão)', async () => {
    const client = fakeLegacyClient();
    stubFetch(() => jsonResponse({ data: { id: 'msg_x' } }));

    await expect(sendPrompt(client as any, 'ses_FA123', 'hi', 'build')).rejects.toThrow(
      /creation/i,
    );
    await expect(
      sendPrompt(client as any, 'ses_FA123', 'hi', undefined, {
        providerID: 'a',
        modelID: 'm',
      }),
    ).rejects.toThrow(/creation/i);
    expect(calls).toHaveLength(0);
  });

  it('createSessionAndPrompt fixa agent/model na criação e envia {text}', async () => {
    const client = fakeLegacyClient({
      create: vi.fn().mockResolvedValue({ data: { id: 'ses_NEW' } }),
    });
    stubFetch(() => jsonResponse({ data: { id: 'msg_new' } }));

    const sessionId = await createSessionAndPrompt(client as any, 'do work', 'build', {
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-20250514',
    });

    expect(sessionId).toBe('ses_NEW');
    expect(client.session.create).toHaveBeenCalledWith({
      body: {
        agent: 'build',
        model: { providerID: 'anthropic', id: 'claude-sonnet-4-20250514' },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/session/ses_NEW/prompt`);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ text: 'do work' });
    expect(client.session.promptAsync).not.toHaveBeenCalled();
  });

  it('forkJobSession envia additionalPrompt via /prompt e nada sem ele', async () => {
    const client = fakeLegacyClient({
      fork: vi.fn().mockResolvedValue({ data: { id: 'ses_FORK' } }),
    });
    stubFetch(() => jsonResponse({ data: { id: 'msg_fork' } }));

    const id = await forkJobSession(client as any, 'ses_SRC', {
      sourceJobName: 'a',
      newJobName: 'b',
      additionalPrompt: 'Continue',
    });
    expect(id).toBe('ses_FORK');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/session/ses_FORK/prompt`);
    expect(JSON.parse(String(calls[0].init?.body)).text).toMatch(/Continue/);
    expect(client.session.promptAsync).not.toHaveBeenCalled();

    stubFetch(() => jsonResponse({ data: { id: 'msg_fork2' } }));
    await forkJobSession(client as any, 'ses_SRC', { sourceJobName: 'a', newJobName: 'b' });
    expect(calls).toHaveLength(0);
  });
});

describe('lane FA: waitForServer rejeita HTML-SPA como ready', () => {
  it('lista HTML (string) não conta como ready; JSON sim', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: '<!doctype html><html>spa</html>' })
      .mockResolvedValueOnce({ data: [] });
    vi.spyOn(sdk, 'createOpencodeClient').mockImplementation((() => ({
      session: { list },
    })) as any);

    const client = await waitForServer(18998, { timeoutMs: 5_000 });
    expect(client).toBeDefined();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('resposta {error} (ex. 401) não conta como ready', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: undefined, error: { message: 'Unauthorized' } })
      .mockResolvedValueOnce({ data: [] });
    vi.spyOn(sdk, 'createOpencodeClient').mockImplementation((() => ({
      session: { list },
    })) as any);

    const client = await waitForServer(18997, { timeoutMs: 5_000 });
    expect(client).toBeDefined();
    expect(list).toHaveBeenCalledTimes(2);
  });
});
