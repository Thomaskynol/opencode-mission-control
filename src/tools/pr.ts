import { tool, type ToolDefinition } from '@opencode-ai/plugin';
import { getDefaultBranch } from '../lib/git';
import { requireHumanAuth, type PublishAuthOptions } from '../lib/integration';
import { getJobByName, type Job } from '../lib/job-state';

export async function executeGhCommand(args: string[]): Promise<string> {
  const proc = Bun.spawn(['gh', 'pr', 'create', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`gh pr create failed: ${stderr || stdout}`);
  }

  return stdout.trim();
}

async function loadPrTemplate(cwd?: string): Promise<string | null> {
  const candidates = [
    '.github/pull_request_template.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    'pull_request_template.md',
    'PULL_REQUEST_TEMPLATE.md',
    '.github/PULL_REQUEST_TEMPLATE/pull_request_template.md',
  ];

  for (const candidate of candidates) {
    try {
      const fullPath = cwd ? `${cwd}/${candidate}` : candidate;
      const file = Bun.file(fullPath);
      if (await file.exists()) {
        return await file.text();
      }
    } catch {
      continue;
    }
  }
  return null;
}

function buildDefaultBody(job: Job): string {
  return [
    '## Summary',
    '',
    job.prompt,
    '',
    '## Changes',
    '',
    `Branch: \`${job.branch}\``,
    '',
    '---',
    '',
    '🚀 *Created by [Mission Control](https://github.com/nigel-dev/opencode-mission-control)*',
  ].join('\n');
}

export const mc_pr: ToolDefinition = tool({
  description: 'Create a pull request from a job\'s branch',
  args: {
    name: tool.schema
      .string()
      .describe('Job name'),
    title: tool.schema
      .string()
      .optional()
      .describe('PR title — use Conventional Commits format (e.g. "feat: add login", "fix: resolve timeout"). Defaults to job name.'),
    body: tool.schema
      .string()
      .optional()
      .describe('PR body (defaults to PR template or generated summary)'),
    draft: tool.schema
      .boolean()
      .optional()
      .describe('Create as draft PR'),
    baseBranch: tool.schema
      .string()
      .optional()
      .describe('Target branch for the PR (defaults to the job\'s base branch, or the repo default branch)'),
    humanAuth: tool.schema
      .boolean()
      .optional()
      .describe('Explicit human authorization to push and create the PR (required, no default push)'),
  },
  async execute(args) {
    // 1. Get job by name
    const job = await getJobByName(args.name);
    if (!job) {
      throw new Error(`Job "${args.name}" not found`);
    }
    // M5/M7 (pending M1): no push/PR without explicit human authorization.
    // Checked after the lookup so unknown jobs still report "not found".
    const auth: PublishAuthOptions = { humanAuth: (args as { humanAuth?: boolean }).humanAuth };
    requireHumanAuth('git push', auth);
    requireHumanAuth('gh pr create', auth);

    // 2. Push branch to remote before creating PR
    const pushProc = Bun.spawn(['git', 'push', 'origin', job.branch], {
      cwd: job.worktreePath || undefined,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const pushStderr = await new Response(pushProc.stderr).text();
    const pushExitCode = await pushProc.exited;
    if (pushExitCode !== 0) {
      throw new Error(`Failed to push branch "${job.branch}": ${pushStderr}`);
    }

    // 3. Determine PR title (conventional commit format)
    const prTitle = args.title || job.name;

    // 4. Build gh pr create arguments
    const baseBranch = args.baseBranch ?? job.baseBranch ?? await getDefaultBranch(job.worktreePath);
    const ghArgs: string[] = [
      '--title', prTitle,
      '--head', job.branch,
      '--base', baseBranch,
    ];

    // 5. Build PR body — use explicit body, or fall back to default
    const mcAttribution = '\n\n---\n\n🚀 *Created by [Mission Control](https://github.com/nigel-dev/opencode-mission-control)*';
    if (args.body) {
      ghArgs.push('--body', args.body + mcAttribution);
    } else {
      const template = await loadPrTemplate(job.worktreePath);
      if (template) {
        ghArgs.push('--body', template + mcAttribution);
      } else {
        ghArgs.push('--body', buildDefaultBody(job));
      }
    }

    // 6. Add draft flag if specified
    if (args.draft) {
      ghArgs.push('--draft');
    }

    // 7. Execute gh pr create
    const prUrl = await executeGhCommand(ghArgs);

    return prUrl;
  },
});
