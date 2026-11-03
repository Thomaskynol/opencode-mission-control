import { afterEach, describe, expect, it } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * P3: pre-existing nested symlinks inside node_modules must be isolated.
 * An absolute (or escaping relative) link to outside the tree lets the test
 * write through into external bytes, execute evil, restore, and still pass —
 * the tree fingerprint only hashed the link target STRING, never the bytes
 * effectively executed. Bun real, disposable fixtures (no git needed here).
 */

let rootDir = '';
afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
  rootDir = '';
});

function makeSource(link: { kind: 'absolute-outside' | 'relative-outside' | 'internal' | 'absolute-inside' | 'workspace' }): { src: string; snap: string; outside: string } {
  rootDir = mkdtempSync(join(tmpdir(), 'mc-p3-tenv-'));
  const src = join(rootDir, 'src');
  const snap = join(rootDir, 'snap');
  const outside = join(rootDir, 'outside');
  mkdirSync(src, { recursive: true });
  mkdirSync(snap, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'index.js'), 'module.exports = () => 2;\n');
  writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: 'demo', main: 'index.js' }));
  mkdirSync(join(src, 'node_modules'), { recursive: true });
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'f' }));
  const linkPath = join(src, 'node_modules/demo');
  if (link.kind === 'absolute-outside') {
    symlinkSync(outside, linkPath);
  } else if (link.kind === 'relative-outside') {
    symlinkSync('../../outside', linkPath);
  } else if (link.kind === 'internal') {
    mkdirSync(join(src, 'node_modules/real-demo'), { recursive: true });
    writeFileSync(join(src, 'node_modules/real-demo/index.js'), 'module.exports = () => 2;\n');
    symlinkSync('./real-demo', linkPath);
  } else if (link.kind === 'absolute-inside') {
    mkdirSync(join(src, 'packs/foo'), { recursive: true });
    writeFileSync(join(src, 'packs/foo/index.js'), 'module.exports = () => 2;\n');
    symlinkSync(join(src, 'packs/foo'), linkPath);
  } else {
    mkdirSync(join(src, 'packs/foo'), { recursive: true });
    writeFileSync(join(src, 'packs/foo/index.js'), 'module.exports = () => 2;\n');
    writeFileSync(join(src, 'packs/foo/package.json'), JSON.stringify({ name: 'demo', main: 'index.js' }));
    symlinkSync('../packs/foo', linkPath);
  }
  return { src, snap, outside };
}

describe('P3 prepareTestEnv nested symlink isolation', () => {
  it('absolute link to outside → env-failure, explicit, origin untouched', async () => {
    const { prepareTestEnv, ENV_UNPREPARED } = await import('../../src/lib/test-env');
    const { src, snap, outside } = makeSource({ kind: 'absolute-outside' });
    const before = readFileSync(join(outside, 'index.js'), 'utf8');
    const r = await prepareTestEnv({ snapshotDir: snap, sourceDir: src });
    expect(r.status).toBe('env-failure');
    expect(r.output).toMatch(/ENV-UNPREPARED/);
    expect(r.output).toMatch(/symlink/i);
    expect(r.output).toMatch(/outside/i);
    expect(ENV_UNPREPARED).toMatch(/ENV-UNPREPARED/);
    // Origin never mutated by preparation.
    expect(readFileSync(join(outside, 'index.js'), 'utf8')).toBe(before);
    expect(lstatSync(join(src, 'node_modules/demo')).isSymbolicLink()).toBe(true);
  });

  it('escaping relative link (../../outside) → env-failure, explicit', async () => {
    const { prepareTestEnv } = await import('../../src/lib/test-env');
    const { src, snap } = makeSource({ kind: 'relative-outside' });
    const r = await prepareTestEnv({ snapshotDir: snap, sourceDir: src });
    expect(r.status).toBe('env-failure');
    expect(r.output).toMatch(/ENV-UNPREPARED/);
    expect(r.output).toMatch(/symlink/i);
  });

  it('absolute link to inside-origin (pins origin, not the copy) → env-failure', async () => {
    const { prepareTestEnv } = await import('../../src/lib/test-env');
    const { src, snap } = makeSource({ kind: 'absolute-inside' });
    const r = await prepareTestEnv({ snapshotDir: snap, sourceDir: src });
    expect(r.status).toBe('env-failure');
    expect(r.output).toMatch(/ENV-UNPREPARED/);
  });

  it('internal relative link (./real-demo) → ready, still a runnable copy', async () => {
    const { prepareTestEnv } = await import('../../src/lib/test-env');
    const { src, snap } = makeSource({ kind: 'internal' });
    const r = await prepareTestEnv({ snapshotDir: snap, sourceDir: src });
    expect(r.status).toBe('ready');
    expect(readFileSync(join(snap, 'node_modules/demo/index.js'), 'utf8')).toBe('module.exports = () => 2;\n');
  });

  it('workspace relative link (../../packs/foo) → ready, resolves inside the copy', async () => {
    const { prepareTestEnv } = await import('../../src/lib/test-env');
    const { src, snap } = makeSource({ kind: 'workspace' });
    // Full-repo snapshots also carry packs/; mirror it like git archive would.
    await Bun.$`cp -a ${join(src, 'packs')} ${join(snap, 'packs')}`.quiet();
    const r = await prepareTestEnv({ snapshotDir: snap, sourceDir: src });
    expect(r.status).toBe('ready');
    expect(readFileSync(join(snap, 'node_modules/demo/index.js'), 'utf8')).toBe('module.exports = () => 2;\n');
  });
});
