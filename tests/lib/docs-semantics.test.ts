import { describe, it, expect, afterEach, beforeEach, mock, spyOn } from 'bun:test';
import { join } from 'path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';
import { assessDocsCoverage } from '../../src/lib/docs-review';

/**
 * Lane docs3 — semantics: mention is not coverage.
 * Literals/titles/links/keywords are auxiliary; coverage requires affirmative
 * explanatory substance, denies/disclaimers block, thin repetition is
 * inconclusive fail-closed (external reviewer or explicit human accept, never auto-pass).
 */

const BACKUP_REQ = { id: 'backup-req-1', description: 'Explain the backup restoration procedure' };
const BACKUP_NEGATION = `# Backup restoration procedure
This document does not explain the backup restoration procedure. Nobody can recover files using these instructions.`;

const BACKUP_CORRECT = `# Backup restoration procedure
To restore, run \`restore.sh --from backup.tar.gz\`, then verify files in /data.
Steps: 1. Open the backup folder 2. Select the snapshot 3. Follow the checklist to recover files.`;

describe('docs semantics: denial blocks, substance required', () => {
  it('EXACT case: negating doc is not covered (RED proof)', () => {
    const r = assessDocsCoverage(BACKUP_REQ, { 'docs/backup.md': BACKUP_NEGATION });
    expect(r.covered).toBe(false);
    expect(r.status).not.toBe('covered');
    expect(r.reason).toMatch(/deny|disclaim|inconclusive|fail-closed|explicit|external/i);
  });

  it('correct docs pass (affirmative substance)', () => {
    const r = assessDocsCoverage(BACKUP_REQ, { 'docs/backup.md': BACKUP_CORRECT });
    expect(r.covered).toBe(true);
    expect(r.status).toBe('covered');
  });

  it('absent docs fail', () => {
    const r = assessDocsCoverage(BACKUP_REQ, {});
    expect(r.covered).toBe(false);
    expect(r.status).toBe('not-covered');
  });

  it('EN variation (different wording): targeted denial blocks', () => {
    const r = assessDocsCoverage(
      { id: 'd1', description: 'Describe the deployment rollback steps' },
      { 'docs/deploy.md': `# Deployment rollback\nThis guide doesn't cover the deployment rollback steps. Use another manual for recovery and follow the on-call runbook carefully.` },
    );
    expect(r.covered).toBe(false);
    expect(r.status).not.toBe('covered');
  });

  it('PT variation (different wording): targeted denial blocks', () => {
    const r = assessDocsCoverage(
      { id: 'p1', description: 'Explique o procedimento de backup' },
      { 'docs/guia.md': `# Procedimento de backup\nEste manual não explica o procedimento de backup. Consulte a equipe para definir os próximos passos e abra o chamado com detalhes.` },
    );
    expect(r.covered).toBe(false);
    expect(r.status).not.toBe('covered');
  });

  it('PT futility disclaimer blocks (different wording)', () => {
    const r = assessDocsCoverage(
      { id: 'p2', description: 'Explique como restaurar o banco de dados' },
      { 'docs/banco.md': `# Restaurar banco\nPara restaurar o banco abra o painel, selecione o snapshot e siga o roteiro com atenção.\nNão é possível recuperar dados com estas instruções.` },
    );
    expect(r.covered).toBe(false);
    expect(r.status).not.toBe('covered');
  });

  it('placeholder TODO/TBD blocks (general pattern)', () => {
    const r = assessDocsCoverage(
      { id: 'a1', description: 'Document the API authentication flow (`api key`)' },
      { 'docs/api.md': '# API auth\nTODO: API authentication flow using `api key` — to be written. More details coming soon for api authentication flow with key handling and review.' },
    );
    expect(r.covered).toBe(false);
    expect(r.status).not.toBe('covered');
  });

  it('repetition without explanation does not pass (inconclusive, fail-closed)', () => {
    const r = assessDocsCoverage(BACKUP_REQ, {
      'docs/backup.md': '# Backup restoration procedure\nBackup restoration procedure backup restoration procedure backup restoration procedure backup restoration.',
    });
    expect(r.covered).toBe(false);
    expect(r.status).toBe('inconclusive');
    expect(r.reason).toMatch(/inconclusive|fail-closed|substance/i);
  });

  it('broken relative link fails', () => {
    const req = { id: 'r1', description: 'README documents installation (`bun install`) and how to run checks (`bun test`)' };
    const withLink = `# MyApp\n\nInstallation: run \`bun install\` to fetch dependencies.\n\nChecks: run \`bun test\` to execute the suite.\n\nSee the [deployment guide](docs/deploy.md) for details.\n`;
    const bad = assessDocsCoverage(req, { 'README.md': withLink }, { existingPaths: ['README.md'] });
    expect(bad.covered).toBe(false);
    expect(bad.reason).toMatch(/link/i);
  });

  it('missing required literal fails (broken command)', () => {
    const req = { id: 'r1', description: 'README documents installation (`bun install`) and how to run checks (`bun test`)' };
    const r = assessDocsCoverage(req, {
      'README.md': '# MyApp\n\nInstallation: run the installer to fetch dependencies and configure the workspace.\n\nChecks: run the suite to execute all validations and review the output carefully.\n',
    });
    expect(r.covered).toBe(false);
  });

  it('negation about an unrelated topic does not veto a covered criterion', () => {
    const r = assessDocsCoverage(BACKUP_REQ, {
      'docs/backup.md': '# Backup restoration procedure\nThis guide does not cover Windows installation. To restore, run `restore.sh --from backup.tar.gz`, then verify files in /data. Open the folder, select the snapshot, and follow the checklist to recover files carefully.',
    });
    expect(r.covered).toBe(true);
    expect(r.status).toBe('covered');
  });
});
