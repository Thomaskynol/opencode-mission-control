import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spyOn, mock } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtemp, mkdir, readFile, writeFile } from 'fs/promises';
import { rmSync, existsSync, lstatSync, symlinkSync } from 'fs';
import {
  ensureServePluginConfig,
  resolveHostPluginBundle,
  MC_SERVE_PLUGIN_DIR,
} from '../../src/lib/worktree-setup';
import { writeServeLauncherScript } from '../../src/lib/prompt-file';
import * as sdkClientMod from '../../src/lib/sdk-client';

let base = '';

async function makeTemp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mc-serve-plugin-test-'));
}

describe('serve plugin config (mc_report/mc_status no serve)', () => {
  beforeEach(async () => {
    base = await makeTemp();
  });

  afterEach(() => {
    mock.restore();
    if (base && existsSync(base)) rmSync(base, { recursive: true, force: true });
  });

  it('resolveHostPluginBundle encontra dist/index.js (bundle construído)', () => {
    const bundle = resolveHostPluginBundle();
    expect(bundle).toBeTruthy();
    expect(bundle!.endsWith('dist/index.js')).toBe(true);
    expect(existsSync(bundle!)).toBe(true);
  });

  it('ensureServePluginConfig materializa .opencode/plugins/mc-mission-control/index.js', async () => {
    const wt = join(base, 'wt1');
    await mkdir(wt, { recursive: true });
    const res = await ensureServePluginConfig(wt);
    expect(res.ok).toBe(true);
    const pluginPath = join(wt, MC_SERVE_PLUGIN_DIR, 'index.js');
    expect(existsSync(pluginPath)).toBe(true);
    expect(res.pluginPath).toBe(pluginPath);
    // Idempotente: segunda chamada reusa cached sem re-copiar.
    const res2 = await ensureServePluginConfig(wt);
    expect(res2.ok).toBe(true);
    expect(res2.source).toBe('cached');
  });

  it('writeServeLauncherScript garante plugin antes do serve subir (sem quebrar launcher)', async () => {
    const wt = join(base, 'wt2');
    await mkdir(wt, { recursive: true });
    const launcher = await writeServeLauncherScript(wt, 14999, 'pw-test');
    const script = await readFile(launcher, 'utf-8');
    expect(script).toContain('OPENCODE_SERVER_PASSWORD=');
    expect(script).not.toContain('CRITICAL');
    // Plugin garantido no worktree (fail-open: ok true quando bundle existe).
    expect(existsSync(join(wt, MC_SERVE_PLUGIN_DIR, 'index.js'))).toBe(true);
  });

  it('converte .opencode symlink em dir real + plugin (não polui o main)', async () => {
    const mainDot = join(base, 'main-dot');
    const wt = join(base, 'wt3');
    await mkdir(join(mainDot, 'plugins', 'other'), { recursive: true });
    await writeFile(join(mainDot, 'plugins', 'other', 'index.js'), '// other');
    await mkdir(wt, { recursive: true });
    symlinkSync(mainDot, join(wt, '.opencode'));
    expect(lstatSync(join(wt, '.opencode')).isSymbolicLink()).toBe(true);

    const res = await ensureServePluginConfig(wt);
    expect(res.ok).toBe(true);
    // Virou dir real, não symlink.
    expect(lstatSync(join(wt, '.opencode')).isSymbolicLink()).toBe(false);
    // Conteúdo herdado preservado + plugin adicionado.
    expect(existsSync(join(wt, '.opencode', 'plugins', 'other', 'index.js'))).toBe(true);
    expect(existsSync(join(wt, MC_SERVE_PLUGIN_DIR, 'index.js'))).toBe(true);
    // Main intocado (sem mc-mission-control lá).
    expect(existsSync(join(mainDot, 'plugins', 'mc-mission-control', 'index.js'))).toBe(false);
  });

  it('launchWorkerViaServe garante plugin (idempotente, fail-open)', async () => {
    const wt = join(base, 'wt4');
    await mkdir(wt, { recursive: true });
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: unknown) => {
      seen.push(String(url));
      if (String(url).endsWith('/api/session') && (init as any)?.method === 'POST') {
        return new Response(
          JSON.stringify({ data: { id: 'ses_9', model: { providerID: 'p', id: 'm' } } }),
          { status: 200 },
        );
      }
      if (String(url).endsWith('/api/session/ses_9/prompt')) {
        return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    try {
      const handle = await sdkClientMod.launchWorkerViaServe(
        sdkClientMod.createV2Client(17891),
        {
          worktree: wt,
          prompt: 'do work',
          profile: { permissions: [{ action: 'read', resource: `${wt}/**`, effect: 'allow' }] },
        },
      );
      expect(handle.sessionId).toBe('ses_9');
      expect(existsSync(join(wt, MC_SERVE_PLUGIN_DIR, 'index.js'))).toBe(true);
      // Echo mode: POST session + POST prompt, sem GET extra.
      expect(seen.filter((s) => s.endsWith('/api/session')).length).toBeGreaterThanOrEqual(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('sucesso materializado retorna loadAck false + log visível sem-ACK (nunca "garantido")', async () => {
    const wt = join(base, 'wt-ack');
    await mkdir(wt, { recursive: true });
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: any[]) => { warns.push(a.map(String).join(' ')); };
    try {
      const res = await ensureServePluginConfig(wt);
      expect(res.ok).toBe(true);
      // Carga pelo serve nunca é confirmada pelo runtime: sempre false.
      expect((res as { loadAck?: unknown }).loadAck).toBe(false);
      expect(warns.some((w) => /preparado mas carga n.o comprovada.*sem ACK do serve/.test(w))).toBe(true);
      expect(warns.some((w) => /garantido/i.test(w))).toBe(false);
    } finally {
      console.warn = orig;
    }
  });

  it('cache (idempotente) também expõe loadAck false + sem-ACK visível', async () => {
    const wt = join(base, 'wt-ack-cached');
    await mkdir(wt, { recursive: true });
    await ensureServePluginConfig(wt);
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: any[]) => { warns.push(a.map(String).join(' ')); };
    try {
      const res2 = await ensureServePluginConfig(wt);
      expect(res2.ok).toBe(true);
      expect(res2.source).toBe('cached');
      expect((res2 as { loadAck?: unknown }).loadAck).toBe(false);
      expect(warns.some((w) => /sem ACK do serve/.test(w))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });
});
