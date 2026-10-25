import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';

export function createJobClient(
  port: number,
  password?: string,
): OpencodeClient {
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers: Record<string, string> = {};

  if (password) {
    headers['Authorization'] =
      'Basic ' + Buffer.from('opencode:' + password).toString('base64');
  }

  return createOpencodeClient({
    baseUrl,
    headers,
  });
}

export interface WaitForServerOptions {
  timeoutMs?: number;
  password?: string;
}

/**
 * Wait for an opencode serve instance to become ready.
 * Polls with exponential backoff until the server responds.
 */
export async function waitForServer(
  port: number,
  options?: WaitForServerOptions,
): Promise<OpencodeClient> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const client = createJobClient(port, options?.password);

  const startTime = Date.now();
  let delay = 100;
  const maxDelay = 5_000;
  const backoffFactor = 1.5;

  while (Date.now() - startTime < timeoutMs) {
    try {
      await client.session.list();
      return client;
    } catch {
      const remaining = timeoutMs - (Date.now() - startTime);
      const waitTime = Math.min(delay, remaining, maxDelay);
      if (waitTime <= 0) break;

      await new Promise((resolve) => setTimeout(resolve, waitTime));
      delay = Math.min(delay * backoffFactor, maxDelay);
    }
  }

  throw new Error(
    `Server on port ${port} did not become ready within ${timeoutMs}ms`,
  );
}

/**
 * Send a prompt to a session via the SDK.
 * Uses promptAsync to return immediately without waiting for completion.
 */
export async function sendPrompt(
  client: OpencodeClient,
  sessionId: string,
  prompt: string,
  agent?: string,
  model?: { providerID: string; modelID: string },
): Promise<void> {
  try {
    await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [{ type: 'text', text: prompt }],
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
      },
    });
  } catch (error) {
    throw new Error(
      `Failed to send prompt to session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function createSessionAndPrompt(
  client: OpencodeClient,
  prompt: string,
  agent?: string,
  model?: { providerID: string; modelID: string },
): Promise<string> {
  const result = await client.session.create();

  if (!result.data) {
    throw new Error(
      `Failed to create session: ${result.error ? JSON.stringify(result.error) : 'unknown error'}`,
    );
  }

  const sessionId = result.data.id;
  await sendPrompt(client, sessionId, prompt, agent, model);
  return sessionId;
}

export interface ForkSessionOptions {
  sourceJobName: string;
  newJobName: string;
  additionalPrompt?: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
}

export async function forkJobSession(
  client: OpencodeClient,
  sourceSessionId: string,
  options: ForkSessionOptions,
): Promise<string> {
  const forkResult = await client.session.fork({
    path: { id: sourceSessionId },
    body: {},
  });

  if (!forkResult.data) {
    throw new Error(
      `Failed to fork session: ${forkResult.error ? JSON.stringify(forkResult.error) : 'unknown error'}`,
    );
  }

  const newSessionId = forkResult.data.id;

  if (options.additionalPrompt) {
    const contextPrompt = `Forked from job "${options.sourceJobName}" as "${options.newJobName}".\n\nAdditional context: ${options.additionalPrompt}`;
    await sendPrompt(
      client,
      newSessionId,
      contextPrompt,
      options.agent,
      options.model,
    );
  }

  return newSessionId;
}

// ---------------------------------------------------------------------------
// v2 session API (opencode 2.1.4 `serve`, JSON under the `/api` prefix).
//
// The legacy `OpencodeClient` above targets unprefixed paths the 2.x server
// no longer serves, so the helpers below speak the verified 2.1.4 surface
// directly over fetch: session.create {model:{providerID,id,variant},
// agent, location:{directory}, permissions} plus prompt / generate /
// interrupt / background / wait / log / message / active / fork / move /
// compact. Additive only: nothing above this line changes.
// ---------------------------------------------------------------------------

/** Model pin used at session creation: exact providerID/id/variant triple. */
export interface V2ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

/** Permission rule as accepted by the 2.1.4 session endpoints. */
export interface V2PermissionRule {
  action: string;
  resource: string;
  effect: 'allow' | 'deny' | 'ask';
}

/** Subset of Session.Info returned by the 2.1.4 server. */
export interface V2SessionInfo {
  id: string;
  projectID: string;
  agent?: string;
  model?: V2ModelRef;
  location: { directory: string };
  permissions?: V2PermissionRule[];
  title?: string;
}

export interface V2CreateSessionBody {
  id?: string;
  parentID?: string;
  title?: string;
  agent?: string;
  model?: V2ModelRef;
  location?: { directory: string };
  permissions?: V2PermissionRule[];
}

/** Minimal client for the 2.1.4 `/api` surface (fetch-based, no SDK bump). */
export interface V2Client {
  baseUrl: string;
  headers: Record<string, string>;
}

export function createV2Client(port: number, password?: string): V2Client {
  const baseUrl = `http://127.0.0.1:${port}/api`;
  const headers: Record<string, string> = {};

  if (password) {
    headers['Authorization'] =
      'Basic ' + Buffer.from('opencode:' + password).toString('base64');
  }

  return { baseUrl, headers };
}

async function v2Request(
  client: V2Client,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(client.baseUrl + path, {
      method,
      headers: {
        ...client.headers,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new Error(
      `v2 ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Never echo auth headers or credentials into errors.
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`v2 ${method} ${path} failed (${response.status}): ${detail}`);
  }

  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`v2 ${method} ${path} returned non-JSON output`);
  }
}

function unwrapData<T>(payload: unknown, what: string): T {
  if (payload !== null && typeof payload === 'object' && 'data' in payload) {
    return (payload as { data: T }).data;
  }
  throw new Error(`v2 ${what} response is missing the data envelope`);
}

async function v2RequestText(
  client: V2Client,
  method: string,
  path: string,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(client.baseUrl + path, {
      method,
      headers: { ...client.headers },
    });
  } catch (error) {
    throw new Error(
      `v2 ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Never echo auth headers or credentials into errors.
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`v2 ${method} ${path} failed (${response.status}): ${detail}`);
  }

  return response.text();
}

export async function v2CreateSession(
  client: V2Client,
  body: V2CreateSessionBody,
): Promise<V2SessionInfo> {
  const payload = await v2Request(client, 'POST', '/session', body);
  return unwrapData<V2SessionInfo>(payload, 'create session');
}

export async function v2GetSession(
  client: V2Client,
  sessionID: string,
): Promise<V2SessionInfo> {
  const payload = await v2Request(
    client,
    'GET',
    `/session/${encodeURIComponent(sessionID)}`,
  );
  return unwrapData<V2SessionInfo>(payload, 'get session');
}

export async function v2ActiveSessions(client: V2Client): Promise<V2SessionInfo[]> {
  const payload = await v2Request(client, 'GET', '/session/active');
  return unwrapData<V2SessionInfo[]>(payload, 'active sessions');
}

export async function v2Prompt(
  client: V2Client,
  sessionID: string,
  text: string,
): Promise<unknown> {
  const payload = await v2Request(
    client,
    'POST',
    `/session/${encodeURIComponent(sessionID)}/prompt`,
    { text },
  );
  return unwrapData<unknown>(payload, 'prompt');
}

export async function v2Generate(
  client: V2Client,
  sessionID: string,
  prompt: string,
): Promise<unknown> {
  // The 2.1.4 server returns the raw generate payload (no data envelope).
  return v2Request(
    client,
    'POST',
    `/session/${encodeURIComponent(sessionID)}/generate`,
    { prompt },
  );
}

export async function v2Interrupt(
  client: V2Client,
  sessionID: string,
  resume = false,
): Promise<unknown> {
  // The 2.1.4 server returns {"interrupted":bool} (no data envelope).
  const path =
    `/session/${encodeURIComponent(sessionID)}/interrupt` + (resume ? '?resume=true' : '');
  return v2Request(client, 'POST', path);
}

export async function v2Background(
  client: V2Client,
  sessionID: string,
): Promise<unknown> {
  // 204 with an empty body on success.
  return v2Request(
    client,
    'POST',
    `/session/${encodeURIComponent(sessionID)}/background`,
  );
}

export async function v2Wait(client: V2Client, sessionID: string): Promise<unknown> {
  // 204 with an empty body once the loop is idle.
  return v2Request(
    client,
    'POST',
    `/experimental/session/${encodeURIComponent(sessionID)}/wait`,
  );
}

export async function v2SessionLog(
  client: V2Client,
  sessionID: string,
): Promise<string> {
  // Server-sent events stream; returned as raw text for the caller to parse.
  return v2RequestText(
    client,
    'GET',
    `/experimental/session/${encodeURIComponent(sessionID)}/log`,
  );
}

export async function v2Messages(
  client: V2Client,
  sessionID: string,
  limit?: number,
): Promise<unknown> {
  const query = limit !== undefined ? `?limit=${limit}` : '';
  const payload = await v2Request(
    client,
    'GET',
    `/session/${encodeURIComponent(sessionID)}/message${query}`,
  );
  return unwrapData<unknown>(payload, 'messages');
}

export async function v2GetMessage(
  client: V2Client,
  sessionID: string,
  messageID: string,
): Promise<unknown> {
  const payload = await v2Request(
    client,
    'GET',
    `/session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}`,
  );
  return unwrapData<unknown>(payload, 'message');
}

export async function v2ForkSession(
  client: V2Client,
  sessionID: string,
  before?: string,
): Promise<V2SessionInfo> {
  const payload = await v2Request(
    client,
    'POST',
    `/session/${encodeURIComponent(sessionID)}/fork`,
    before !== undefined ? { before } : {},
  );
  return unwrapData<V2SessionInfo>(payload, 'fork session');
}

export async function v2MoveSession(
  client: V2Client,
  sessionID: string,
  directory: string,
): Promise<unknown> {
  // 204 with an empty body on success.
  return v2Request(
    client,
    'POST',
    `/session/${encodeURIComponent(sessionID)}/move`,
    { directory },
  );
}

export async function v2CompactSession(
  client: V2Client,
  sessionID: string,
): Promise<unknown> {
  const payload = await v2Request(
    client,
    'POST',
    `/session/${encodeURIComponent(sessionID)}/compact`,
    {},
  );
  return unwrapData<unknown>(payload, 'compact session');
}

// ---------------------------------------------------------------------------
// v2 readiness + forms + permissions (2.1.4 `/api` surface, verified live).
// The legacy unprefixed SDK (`/session`, `/global/event`) is not served by
// 2.1.4, so every worker-session touchpoint goes through the helpers below.
// ---------------------------------------------------------------------------

export interface V2WaitForServerOptions {
  timeoutMs?: number;
  password?: string;
}

/**
 * Wait for a serve instance to answer. Polls GET /api/info (server-scoped:
 * unlike /api/session, it never leaks another project's sessions and only
 * succeeds once THIS server is up).
 */
export async function v2WaitForServer(
  port: number,
  options?: V2WaitForServerOptions,
): Promise<V2Client> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const client = createV2Client(port, options?.password);

  const startTime = Date.now();
  let delay = 100;
  const maxDelay = 5_000;
  const backoffFactor = 1.5;

  while (Date.now() - startTime < timeoutMs) {
    try {
      await v2Request(client, 'GET', '/info');
      return client;
    } catch {
      const remaining = timeoutMs - (Date.now() - startTime);
      const waitTime = Math.min(delay, remaining, maxDelay);
      if (waitTime <= 0) break;

      await new Promise((resolve) => setTimeout(resolve, waitTime));
      delay = Math.min(delay * backoffFactor, maxDelay);
    }
  }

  throw new Error(
    `Server on port ${port} did not become ready within ${timeoutMs}ms`,
  );
}

/** Quote a path for `bash '...'` / `"$(cat '...')"` launcher lines. */
export function quoteShellPath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** One selectable option inside a form field (question tool answers). */
export interface V2FormOption {
  value: string;
  label: string;
  description?: string;
}

export interface V2FormField {
  key: string;
  type: string;
  title?: string;
  description?: string;
  options?: V2FormOption[];
  custom?: boolean;
}

export interface V2FormInfo {
  id: string;
  sessionID: string;
  title: string;
  metadata?: Record<string, unknown>;
  fields: V2FormField[];
}

export interface V2FormDetail extends V2FormInfo {
  state: { status: string; answer?: Record<string, unknown>; message?: string };
}

export async function v2ListForms(client: V2Client, sessionID: string): Promise<V2FormInfo[]> {
  const payload = await v2Request(
    client,
    'GET',
    `/session/${encodeURIComponent(sessionID)}/form`,
  );
  return unwrapData<V2FormInfo[]>(payload, 'list forms');
}

export async function v2GetForm(
  client: V2Client,
  sessionID: string,
  formID: string,
): Promise<V2FormDetail> {
  const payload = await v2Request(
    client,
    'GET',
    `/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}`,
  );
  return unwrapData<V2FormDetail>(payload, 'get form');
}

export async function v2CreateForm(
  client: V2Client,
  sessionID: string,
  title: string,
  fields: V2FormField[],
): Promise<V2FormInfo> {
  const payload = await v2Request(
    client,
    'POST',
    `/session/${encodeURIComponent(sessionID)}/form`,
    { title, fields },
  );
  return unwrapData<V2FormInfo>(payload, 'create form');
}

/**
 * Answer a pending form. The answer maps field keys to values; option
 * answers use the option `value`. 204 with an empty body on success.
 */
export async function v2ReplyForm(
  client: V2Client,
  sessionID: string,
  formID: string,
  answer: Record<string, unknown>,
): Promise<void> {
  await v2Request(
    client,
    'POST',
    `/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}/reply`,
    { answer },
  );
}

export type V2PermissionDecision = 'once' | 'always' | 'reject';

export interface V2PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  message?: string;
}

export async function v2ListPermissions(
  client: V2Client,
  sessionID: string,
): Promise<V2PermissionRequest[]> {
  const payload = await v2Request(
    client,
    'GET',
    `/session/${encodeURIComponent(sessionID)}/permission`,
  );
  return unwrapData<V2PermissionRequest[]>(payload, 'list permissions');
}

/**
 * Reply to a pending permission request owned by the session.
 * Session-scoped: the legacy unprefixed `/permission/:id/reply` path
 * answers 405 on 2.1.4. 204 with an empty body on success.
 */
export async function v2ReplyPermission(
  client: V2Client,
  sessionID: string,
  requestID: string,
  decision: V2PermissionDecision,
  message?: string,
): Promise<void> {
  await v2Request(
    client,
    'POST',
    `/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`,
    message !== undefined ? { decision, message } : { decision },
  );
}
