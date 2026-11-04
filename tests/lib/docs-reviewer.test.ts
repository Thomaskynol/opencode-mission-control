import { describe, it, expect } from 'bun:test';
import { buildDocsPrompt, reviewDocsViaOpenCode } from '../../src/lib/opencode-reviewer';

/**
 * RED: docs semantic reviewer contract (TDD).
 * Heuristics are auxiliary only; verified requires an OpenCode semantic
 * verdict with reasons + specific evidence (doc citations), fail-closed.
 */

const REQ = { id: 'backup-req-1', description: 'Explain the backup restoration procedure' };
const WRONG_DOC = `# Backup restoration procedure
To restore, run \`restore.sh --from backup.tar.gz --delete-source\`, then verify files in /data-restored.
Steps: 1. Open the backup folder 2. Select the snapshot 3. Run \`rm -rf /data\` to clean before restore and follow the checklist to recover files carefully.`;

describe('docs reviewer prompt contract', () => {
  it('prompt carries requirement + docs content and demands reasons + citations (strict JSON, fail-closed)', () => {
    const prompt = buildDocsPrompt({
      requirements: [REQ],
      docsFiles: { 'docs/backup.md': WRONG_DOC },
    });
    expect(prompt).toMatch(/backup-req-1/);
    expect(prompt).toMatch(/Explain the backup restoration procedure/);
    expect(prompt).toMatch(/restore\.sh/);
    expect(prompt).toMatch(/evidence/i);
    expect(prompt).toMatch(/reason/i);
    expect(prompt).toMatch(/STRICT JSON/i);
    expect(prompt).toMatch(/fail|inconclusive/i);
    expect(prompt).toMatch(/empty.*evidence|evidence.*empty/i);
  });
});

describe('docs reviewer fail-closed transport', () => {
  it('invalid binary resolves to never-verified (inconclusive, fail-closed) without throwing', async () => {
    const results = await reviewDocsViaOpenCode(
      {
        requirements: [REQ],
        docsFiles: { 'docs/backup.md': WRONG_DOC },
        bin: '/nonexistent-opencode-bin-xyz',
        timeoutMs: 15_000,
      },
      'opencode-go/muse-spark-1.3-contributor',
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.verdict).not.toBe('pass');
    expect(results[0]!.demonstrated).toBe(false);
    expect(results[0]!.reason).toMatch(/fail-closed|unavailable|failed/i);
  });

  it('unpinned model (no effective, no env) resolves to never-verified without invoking', async () => {
    const saved = process.env.MC_REVIEW_MODEL;
    delete process.env.MC_REVIEW_MODEL;
    try {
      const results = await reviewDocsViaOpenCode(
        {
          requirements: [REQ],
          docsFiles: { 'docs/backup.md': WRONG_DOC },
          bin: '/nonexistent-opencode-bin-xyz',
          timeoutMs: 15_000,
        },
        undefined,
      );
      expect(results).toHaveLength(1);
      expect(results[0]!.verdict).not.toBe('pass');
      expect(results[0]!.reason).toMatch(/unpinned|fail-closed/i);
    } finally {
      if (saved !== undefined) process.env.MC_REVIEW_MODEL = saved;
    }
  });

  it('empty requirements resolve to empty without invoking', async () => {
    const results = await reviewDocsViaOpenCode(
      { requirements: [], docsFiles: { 'docs/backup.md': WRONG_DOC } },
      'opencode-go/muse-spark-1.3-contributor',
    );
    expect(results).toEqual([]);
  });
});
