import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { getJobByName } from '../lib/job-state';
import { gitCommand, getDefaultBranch } from '../lib/git';

async function executeGitDiff(
  worktreePath: string,
  branch: string,
  stat: boolean = false,
  baseBranch?: string,
): Promise<string> {
  // Contrato: base é do plano/tarefa, nunca origin/main fixo — unificada em getDefaultBranch.
  const base = baseBranch ?? (await getDefaultBranch(worktreePath));
  const baseCheck = await gitCommand(['rev-parse', '--verify', base], {
    cwd: worktreePath,
  });
  if (baseCheck.exitCode !== 0) {
    throw new Error(
      `Cannot diff: base branch "${base}" not found in ${worktreePath} ` +
        `(no remote default, main, or master matched — set an explicit baseBranch instead of guessing)`,
    );
  }

  const args = ['diff'];
  if (stat) {
    args.push('--stat');
  }
  args.push(`${base}..${branch}`);

  const diffResult = await gitCommand(args, { cwd: worktreePath });

  if (diffResult.exitCode !== 0) {
    throw new Error(`git diff failed: ${diffResult.stderr || diffResult.stdout}`);
  }

  return diffResult.stdout;
}

export const mc_diff: ToolDefinition = tool({
  description: 'Show changes in a job\'s branch compared to base',
  args: {
    name: tool.schema
      .string()
      .describe('Job name'),
    stat: tool.schema
      .boolean()
      .optional()
      .describe('Show diffstat only'),
  },
  async execute(args) {
    // 1. Get job by name
    const job = await getJobByName(args.name);
    if (!job) {
      throw new Error(`Job "${args.name}" not found`);
    }

    // 2. Execute git diff
    const diff = await executeGitDiff(job.worktreePath, job.branch, args.stat, job.baseBranch);

    // 3. Return diff output
    return diff || '(no changes)';
  },
});
