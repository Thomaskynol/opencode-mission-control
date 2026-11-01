import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'node:child_process';

/** F test-env parity: same commit both ways → same verdict; impossible prep → env-failure. */
describe('test-env parity (F)', () => {
  let base = '';

  function makeFixture(withLockfile: boolean, offline: boolean): { dir: string; head: string } {
    const fs = require('fs') as typeof import('fs');
    const dir = join(base, `f-${withLockfile ? 'lock' : 'nolock'}-${offline ? 'off' : 'on'}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(join(dir, 'node_modules/fake-dep-xyz'), { recursive: true });
    fs.writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'f-fixture', scripts: { test: 'node test.js' } }, null, 2));
    fs.writeFileSync(join(dir, 'test.js'), `const d = require('fake-dep-xyz');\nif (d() !== 42) { console.error('WRONG'); process.exit(1); }\nconsole.log('DEP-OK 42');\n`);
    fs.writeFileSync(join(dir, 'node_modules/fake-dep-xyz/package.json'), JSON.stringify({ name: 'fake-dep-xyz', main: 'index.js' }));
    fs.writeFileSync(join(dir, 'node_modules/fake-dep-xyz/index.js'), `module.exports = () => 42;\n`);
    fs.writeFileSync(join(dir, '.gitignore'), `node_modules/\n`);
    if (withLockfile) {
      // minimal lockfile to trigger install path (content irrelevant for detection)
      fs.writeFileSync(join(dir, 'bun.lock'), `# lockfile\n`);
    }
    execSync(`git init -q . && git config user.email t@t.t && git config user.name t && git add package.json test.js .gitignore ${withLockfile ? 'bun.lock' : ''} && git commit -qm fixture`, { cwd: dir });
    const head = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
    return { dir, head };
  }

  beforeEach(async () => {
    const fs = await import('fs');
    base = await fs.promises.mkdtemp(join(tmpdir(), 'mc-testenv-'));
  });

  afterEach(async () => {
    if (base) {
      try { (require('fs') as typeof import('fs')).rmSync(base, { recursive: true, force: true }); } catch {}
    }
  });

  it('missing dep + no lockfile → env-failure (never pass/skip) in both paths', async () => {
    const { dir, head } = makeFixture(false, false);
    // remove untracked deps to simulate clean snapshot (no node_modules)
    await Bun.$`rm -rf ${dir}/node_modules`.quiet();
    const { runTestsOnImmutableSnapshot } = await import('../../src/lib/candidate-identity');
    const { runTestCommand } = await import('../../src/lib/merge-train');
    const ls = await Bun.$`git -C ${dir} ls-files`.text();
    const tracked = new Set(ls.split('\n').map((s: string) => s.trim()).filter(Boolean));
    const r = await runTestsOnImmutableSnapshot({ dir, scopePaths: ['package.json', 'test.js'], testCommand: 'node test.js', timeoutMs: 60000, jobHead: head, isTracked: (rel: string) => tracked.has(rel) });
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/ENV-UNPREPARED/);
    // integration path: same commit, same missing dep → also fails closed (never pass).
    // Raw run fails with missing module; MergeTrain.processNext converts this to
    // env-failure with ENV-UNPREPARED (see merge-train conversion), preserving parity.
    const integration = await runTestCommand(dir, 'node test.js', 30000);
    expect(integration.success).toBe(false);
    expect(integration.output).toMatch(/Cannot find module|MODULE_NOT_FOUND/i);
  });

  it('missing dep + lockfile, install fails offline → env-failure (never pass/skip)', async () => {
    const fs = require('fs') as typeof import('fs');
    const dir = join(base, `f-lock-off-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(dir, { recursive: true });
    // Declared dep that cannot be resolved offline (fake registry), no node_modules.
    fs.writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'f-lock', scripts: { test: 'node test.js' }, dependencies: { 'fake-dep-xyz': '*' } }, null, 2));
    fs.writeFileSync(join(dir, 'test.js'), `require('fake-dep-xyz'); console.log('ok');`);
    fs.writeFileSync(join(dir, 'bun.lock'), `# lockfile\n`);
    fs.writeFileSync(join(dir, '.gitignore'), `node_modules/\n`);
    execSync(`git init -q . && git config user.email t@t.t && git config user.name t && git add package.json test.js .gitignore bun.lock && git commit -qm fixture`, { cwd: dir });
    const head = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
    const { runTestsOnImmutableSnapshot } = await import('../../src/lib/candidate-identity');
    const ls = await Bun.$`git -C ${dir} ls-files`.text();
    const tracked = new Set(ls.split('\n').map((s: string) => s.trim()).filter(Boolean));
    const r = await runTestsOnImmutableSnapshot({ dir, scopePaths: ['package.json', 'test.js'], testCommand: 'node test.js', timeoutMs: 30000, jobHead: head, isTracked: (rel: string) => tracked.has(rel) });
    // Lockfile present but install fails (invalid lock / offline / unresolvable
    // dep) → env-failure, never pass/skip, never plain test failure.
    expect(r.success).toBe(false);
    expect(r.output).toMatch(/ENV-UNPREPARED/);
  });

  it('parity: same commit with deps available → same success both ways', async () => {    const { dir } = makeFixture(false, false);
    const { runTestsOnImmutableSnapshot } = await import('../../src/lib/candidate-identity');
    const { runTestCommand } = await import('../../src/lib/merge-train');
    const head = (await Bun.$`git -C ${dir} rev-parse HEAD`.text()).trim();
    const ls = await Bun.$`git -C ${dir} ls-files`.text();
    const tracked = new Set(ls.split('\n').map((s: string) => s.trim()).filter(Boolean));
    const review = await runTestsOnImmutableSnapshot({ dir, scopePaths: ['package.json', 'test.js'], testCommand: 'node test.js', timeoutMs: 60000, jobHead: head, isTracked: (rel: string) => tracked.has(rel), keepSnapshotDir: true });
    try {
      const integration = await runTestCommand(dir, 'node test.js', 60000);
      // both should succeed when deps are symlinked/provided
      expect(review.success).toBe(integration.success);
    } finally {
      await Bun.$`rm -rf ${review.snapshotDir}`.quiet();
    }
  });

  it('relative missing require stays test failure, never env-failure', async () => {
    const { isExternalMissingModule } = await import('../../src/lib/test-env');
    expect(isExternalMissingModule(`Error: Cannot find module './utls'`)).toBe(false);
  });

  it('bare missing specifier is env-failure', async () => {
    const { isExternalMissingModule, ENV_UNPREPARED } = await import('../../src/lib/test-env');
    expect(isExternalMissingModule(`Error: Cannot find module 'fake-dep-xyz'`)).toBe(true);
    expect(ENV_UNPREPARED).toMatch(/ENV-UNPREPARED/);
  });
});
