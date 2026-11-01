import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function git(cwd: string, args: string[]): void {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' }) as unknown as { exitCode: number; stderr: Uint8Array };
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(r.stderr)}`);
}
function gitOut(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' }) as unknown as { exitCode: number; stdout: Uint8Array };
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed`);
  return new TextDecoder().decode(r.stdout).trim();
}

/**
 * B3-deadlock: conteúdo já mergeado na integration mas plano marca `failed
 * (empty diff)` legado. O reconciliador nunca re-revisa um job `failed`,
 * então nada resolve: nem reconcile, nem resume, nem retry (que exige pause).
 * A cura: job `failed` com mergeEvidence PASS no MESMO commit cujo conteúdo
 * já está contido na integration → `merged` terminal, sem re-review.
 */
describe('B3-deadlock: failed já integrado com evidência PASS cura para merged (git real)', () => {
  let root = '';
  let repo = '';
  let intWt = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mc-b3dead-'));
    repo = join(root, 'repo');
    intWt = join(root, 'int');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 't@t.com']);
    git(repo, ['config', 'user.name', 'T']);
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }));
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'init']);
    git(repo, ['branch', '-M', 'main']);
    git(repo, ['branch', 'integration']);
    git(repo, ['worktree', 'add', intWt, 'integration']);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('cura: squash-mergeado + evidência PASS no mesmo commit → heal', async () => {
    const { shouldHealFailedAsMerged } = await import('../../src/lib/orchestrator');
    git(repo, ['checkout', '-b', 'feat-cap', 'main']);
    writeFileSync(join(repo, 'cap.txt'), 'cap\n');
    git(repo, ['add', 'cap.txt']);
    git(repo, ['commit', '-m', 'feat cap']);
    const jobHead = gitOut(repo, ['rev-parse', 'feat-cap']);
    git(repo, ['checkout', 'main']);
    // squash na integration: merge-base --is-ancestor é FALSO aqui (novo commit),
    // mas o conteúdo está contido — a cura deve reconhecer via diff vazio.
    git(intWt, ['merge', '--squash', 'feat-cap']);
    git(intWt, ['commit', '-m', 'Merge feat-cap']);
    const res = await shouldHealFailedAsMerged({
      repoRoot: repo,
      integrationBranch: 'integration',
      job: { name: 'feat-cap', branch: 'feat-cap', touchSet: ['cap.txt'] },
      evidence: { testStatus: 'passed', reviewedCommit: jobHead, changedFiles: ['cap.txt'], scope: 'task' },
    });
    expect(res.heal).toBe(true);
  });

  it('nunca cura falha funcional sem evidência PASS', async () => {
    const { shouldHealFailedAsMerged } = await import('../../src/lib/orchestrator');
    git(repo, ['checkout', '-b', 'feat-bad', 'main']);
    writeFileSync(join(repo, 'bad.txt'), 'bad\n');
    git(repo, ['add', 'bad.txt']);
    git(repo, ['commit', '-m', 'feat bad']);
    const jobHead = gitOut(repo, ['rev-parse', 'feat-bad']);
    git(repo, ['checkout', 'main']);
    const base = {
      repoRoot: repo,
      integrationBranch: 'integration',
      job: { name: 'feat-bad', branch: 'feat-bad', touchSet: ['bad.txt'] },
    } as const;
    expect((await shouldHealFailedAsMerged({ ...base, evidence: undefined })).heal).toBe(false);
    expect((await shouldHealFailedAsMerged({ ...base, evidence: { testStatus: 'failed', reviewedCommit: jobHead } })).heal).toBe(false);
    expect((await shouldHealFailedAsMerged({ ...base, evidence: { testStatus: 'skipped', reviewedCommit: jobHead } })).heal).toBe(false);
  });

  it('nunca cura commit divergente (conteúdo fora da integration)', async () => {
    const { shouldHealFailedAsMerged } = await import('../../src/lib/orchestrator');
    git(repo, ['checkout', '-b', 'feat-div', 'main']);
    writeFileSync(join(repo, 'div.txt'), 'v1\n');
    git(repo, ['add', 'div.txt']);
    git(repo, ['commit', '-m', 'feat div v1']);
    const v1 = gitOut(repo, ['rev-parse', 'feat-div']);
    git(repo, ['checkout', 'main']);
    // evidência PASS na v1, mas a branch andou (v2 nunca integrada) → stale, sem cura
    git(repo, ['checkout', 'feat-div']);
    writeFileSync(join(repo, 'div.txt'), 'v2 divergente\n');
    git(repo, ['add', 'div.txt']);
    git(repo, ['commit', '-m', 'feat div v2']);
    git(repo, ['checkout', 'main']);
    const stale = await shouldHealFailedAsMerged({
      repoRoot: repo,
      integrationBranch: 'integration',
      job: { name: 'feat-div', branch: 'feat-div', touchSet: ['div.txt'] },
      evidence: { testStatus: 'passed', reviewedCommit: v1, changedFiles: ['div.txt'], scope: 'task' },
    });
    expect(stale.heal).toBe(false);
    // evidência na v2 mas conteúdo ausente da integration → sem cura
    const v2 = gitOut(repo, ['rev-parse', 'feat-div']);
    const fresh = await shouldHealFailedAsMerged({
      repoRoot: repo,
      integrationBranch: 'integration',
      job: { name: 'feat-div', branch: 'feat-div', touchSet: ['div.txt'] },
      evidence: { testStatus: 'passed', reviewedCommit: v2, changedFiles: ['div.txt'], scope: 'task' },
    });
    expect(fresh.heal).toBe(false);
  });

  it('cura via ancestralidade direta (fast-forward)', async () => {
    const { shouldHealFailedAsMerged } = await import('../../src/lib/orchestrator');
    git(repo, ['checkout', '-b', 'feat-ff', 'main']);
    writeFileSync(join(repo, 'ff.txt'), 'ff\n');
    git(repo, ['add', 'ff.txt']);
    git(repo, ['commit', '-m', 'feat ff']);
    const jobHead = gitOut(repo, ['rev-parse', 'feat-ff']);
    git(repo, ['checkout', 'main']);
    git(intWt, ['merge', '--ff-only', 'feat-ff']);
    const res = await shouldHealFailedAsMerged({
      repoRoot: repo,
      integrationBranch: 'integration',
      job: { name: 'feat-ff', branch: 'feat-ff', touchSet: ['ff.txt'] },
      evidence: { testStatus: 'passed', reviewedCommit: jobHead, changedFiles: ['ff.txt'], scope: 'task' },
    });
    expect(res.heal).toBe(true);
  });
});
