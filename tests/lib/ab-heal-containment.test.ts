import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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

// B — heal must require task-scoped evidence pinned to the commit and prove
// containment of the effectively altered files (real diff --name-only,
// rename/delete distinguished, pattern without correspondence never counts,
// empty diff rejects).

describe('B: heal containment requires task scope + real file proof', () => {
  let root = '';
  let repo = '';
  let intWt = '';
  beforeEach(() => {
    mkdirSync('/tmp/opencode', { recursive: true });
    root = mkdtempSync('/tmp/opencode/ab-b-');
    repo = join(root, 'repo');
    intWt = join(root, 'int');
    mkdirSync(repo, { recursive: true });
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 't@t.com']);
    git(repo, ['config', 'user.name', 'T']);
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }));
    writeFileSync(join(repo, 'base.txt'), 'base\n');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src/total.js'), 'v0\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'init']);
    git(repo, ['branch', '-M', 'main']);
    git(repo, ['branch', 'integration']);
    git(repo, ['worktree', 'add', intWt, 'integration']);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('inconsistent evidence (missing pattern + scope integration + divergent content) → heal:false', async () => {
    const { shouldHealFailedAsMerged } = await import('../../src/lib/orchestrator');
    git(repo, ['checkout', '-b', 'feat-w', 'main']);
    writeFileSync(join(repo, 'src/total.js'), 'v1-worker\n');
    git(repo, ['add', 'src/total.js']);
    git(repo, ['commit', '-m', 'feat']);
    const jobHead = gitOut(repo, ['rev-parse', 'feat-w']);
    git(repo, ['checkout', 'main']);
    const res = await shouldHealFailedAsMerged({
      repoRoot: repo,
      integrationBranch: 'integration',
      job: { name: 'feat-w', branch: 'feat-w', touchSet: ['src/missing/**'] },
      evidence: { testStatus: 'passed', reviewedCommit: jobHead, changedFiles: ['src/total.js'], scope: 'integration' },
    });
    expect(res.heal).toBe(false);
  });

  it('scope integration with otherwise contained content → heal:false (requires task scope)', async () => {
    const { shouldHealFailedAsMerged } = await import('../../src/lib/orchestrator');
    git(repo, ['checkout', '-b', 'feat-cap', 'main']);
    writeFileSync(join(repo, 'cap.txt'), 'cap\n');
    git(repo, ['add', 'cap.txt']);
    git(repo, ['commit', '-m', 'feat cap']);
    const jobHead = gitOut(repo, ['rev-parse', 'feat-cap']);
    git(repo, ['checkout', 'main']);
    git(intWt, ['merge', '--squash', 'feat-cap']);
    git(intWt, ['commit', '-m', 'Merge feat-cap']);
    const res = await shouldHealFailedAsMerged({
      repoRoot: repo,
      integrationBranch: 'integration',
      job: { name: 'feat-cap', branch: 'feat-cap', touchSet: ['cap.txt'] },
      evidence: { testStatus: 'passed', reviewedCommit: jobHead, changedFiles: ['cap.txt'], scope: 'integration' },
    });
    expect(res.heal).toBe(false);
  });

  it('legit squash-merged task evidence → heal:true', async () => {
    const { shouldHealFailedAsMerged } = await import('../../src/lib/orchestrator');
    git(repo, ['checkout', '-b', 'feat-cap2', 'main']);
    writeFileSync(join(repo, 'cap2.txt'), 'cap2\n');
    git(repo, ['add', 'cap2.txt']);
    git(repo, ['commit', '-m', 'feat cap2']);
    const jobHead = gitOut(repo, ['rev-parse', 'feat-cap2']);
    git(repo, ['checkout', 'main']);
    git(intWt, ['merge', '--squash', 'feat-cap2']);
    git(intWt, ['commit', '-m', 'Merge feat-cap2']);
    const res = await shouldHealFailedAsMerged({
      repoRoot: repo,
      integrationBranch: 'integration',
      job: { name: 'feat-cap2', branch: 'feat-cap2', touchSet: ['cap2.txt'] },
      evidence: { testStatus: 'passed', reviewedCommit: jobHead, changedFiles: ['cap2.txt'], scope: 'task' },
    });
    expect(res.heal).toBe(true);
  });
});
