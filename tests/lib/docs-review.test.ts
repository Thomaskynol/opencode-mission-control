import { describe, it, expect } from 'bun:test';
/**
 * Lane docs2 — RED: docs-only gate (src/lib/docs-review.ts ainda não existe).
 *
 * Tarefas que só tocam documentação nunca geram "implementation candidates"
 * no classificador funcional (regex de `export function` sobre fontes) e
 * falham para sempre no ramo 2b de assessFunctionalCoverage. O gate de docs
 * avalia essas tarefas por critérios adequados ao pedido — conteúdo,
 * literais exigidos, links relativos — sem exigir teste de função.
 * Docs inexistente/fora de escopo/que não atende critérios deve ser REJEITADA.
 */
import {
  isDocsOnlyChange,
  isDocsPath,
  assessDocsCoverage,
} from '../../src/lib/docs-review';

const INSTALL_REQ = {
  id: 'readme-req-1',
  description: 'README documents installation (`bun install`) and how to run checks (`bun test`)',
};

const GOOD_README = `# MyApp

Installation: run \`bun install\` to fetch dependencies.

Checks: run \`bun test\` to execute the suite.
`;

describe('isDocsPath / isDocsOnlyChange', () => {
  it('accepts markdown, text and conventional doc names', () => {
    expect(isDocsPath('README.md')).toBe(true);
    expect(isDocsPath('docs/guide.mdx')).toBe(true);
    expect(isDocsPath('CHANGELOG.md')).toBe(true);
    expect(isDocsPath('notes.txt')).toBe(true);
    expect(isDocsPath('docs/manual.rst')).toBe(true);
  });

  it('rejects code and test files', () => {
    expect(isDocsPath('src/total.js')).toBe(false);
    expect(isDocsPath('tests/readme.test.js')).toBe(false);
    expect(isDocsPath('check.mjs')).toBe(false);
  });

  it('isDocsOnlyChange is true only for non-empty, all-docs diffs', () => {
    expect(isDocsOnlyChange(['README.md'])).toBe(true);
    expect(isDocsOnlyChange(['README.md', 'docs/guide.md'])).toBe(true);
    expect(isDocsOnlyChange([])).toBe(false);
    expect(isDocsOnlyChange(['README.md', 'src/total.js'])).toBe(false);
    expect(isDocsOnlyChange(['README.md', 'tests/readme.test.js'])).toBe(false);
  });
});

describe('assessDocsCoverage', () => {
  it('passes a legit docs task (literals + keywords present)', () => {
    const r = assessDocsCoverage(INSTALL_REQ, { 'README.md': GOOD_README });
    expect(r.covered).toBe(true);
  });

  it('rejects docs missing a required literal (negative)', () => {
    const r = assessDocsCoverage(INSTALL_REQ, {
      'README.md': '# MyApp\n\nInstallation: run the installer.\n\nChecks: run the suite.\n',
    });
    expect(r.covered).toBe(false);
    expect(r.reason).toMatch(/bun install|bun test/);
  });

  it('rejects trivial docs (negative: placeholder only)', () => {
    const r = assessDocsCoverage(
      { id: 'r', description: 'README documents installation' },
      { 'README.md': 'TODO\n' },
    );
    expect(r.covered).toBe(false);
    expect(r.reason).toMatch(/trivial|empty|non-trivial/i);
  });

  it('rejects missing docs content (negative: nothing examined)', () => {
    const r = assessDocsCoverage(INSTALL_REQ, {});
    expect(r.covered).toBe(false);
  });

  it('rejects docs about something else (negative: keywords miss)', () => {
    const r = assessDocsCoverage(
      { id: 'r', description: 'README documents the rollback procedure for failed deploys' },
      { 'README.md': GOOD_README },
    );
    expect(r.covered).toBe(false);
  });

  it('rejects a broken relative link when the repo tree is provided (negative)', () => {
    const withLink = `${GOOD_README}\nSee the [deployment guide](docs/deploy.md) for details.\n`;
    const bad = assessDocsCoverage(INSTALL_REQ, { 'README.md': withLink }, { existingPaths: ['README.md'] });
    expect(bad.covered).toBe(false);
    expect(bad.reason).toMatch(/deploy\.md|link/i);
    const good = assessDocsCoverage(
      INSTALL_REQ,
      { 'README.md': withLink, 'docs/deploy.md': '# Deploy\n\nRun `bun test` first, then follow the checklist below step by step.\n' },
      { existingPaths: ['README.md', 'docs/deploy.md'] },
    );
    expect(good.covered).toBe(true);
  });

  it('ignores external links (no false veto)', () => {
    const r = assessDocsCoverage(
      INSTALL_REQ,
      { 'README.md': `${GOOD_README}\nUpstream: [bun](https://bun.sh) — see #faq.\n` },
      { existingPaths: ['README.md'] },
    );
    expect(r.covered).toBe(true);
  });
});
