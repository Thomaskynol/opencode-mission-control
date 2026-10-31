import { spawn, spawnSync } from "bun";

/**
 * Check if tmux is installed and available
 */
export async function isTmuxAvailable(): Promise<boolean> {
  try {
    const proc = spawn(["tmux", "-V"], { stderr: "pipe" });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Validate tmux availability and return a descriptive error or null if available
 */
export async function validateTmux(): Promise<string | null> {
  try {
    const proc = spawn(["tmux", "-V"], { stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return "tmux is not installed or not in PATH";
    }
    return null;
  } catch {
    return "tmux is not installed or not in PATH";
  }
}

/**
 * Check if we're currently inside a tmux session
 */
export function isInsideTmux(): boolean {
  return !!process.env.TMUX;
}

/**
 * Get the current tmux session name
 */
export function getCurrentSession(): string | undefined {
  if (!process.env.TMUX) return undefined;

  try {
    const proc = spawnSync(["tmux", "display-message", "-p", "#{session_name}"], {
      stderr: "pipe",
    });
    if (proc.exitCode === 0) {
      const name = proc.stdout.toString().trim();
      if (name) return name;
    }
  } catch {}

  return undefined;
}

/**
 * Create a new tmux session
 */
export async function createSession(opts: {
  name: string;
  workdir: string;
  command?: string;
}): Promise<void> {
  const args = ["new-session", "-d", "-s", opts.name, "-c", opts.workdir];
  if (opts.command) {
    args.push(opts.command);
  }

  try {
    const proc = spawn(["tmux", ...args], { stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`tmux new-session failed with exit code ${exitCode}`);
    }
  } catch (error) {
    throw new Error(
      `Failed to create tmux session: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Create a new window in an existing tmux session
 */
export async function createWindow(opts: {
  session: string;
  name: string;
  workdir: string;
  command?: string;
}): Promise<void> {
  const args = [
    "new-window",
    "-t",
    opts.session,
    "-n",
    opts.name,
    "-c",
    opts.workdir,
  ];
  if (opts.command) {
    args.push(opts.command);
  }

  try {
    const proc = spawn(["tmux", ...args], { stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`tmux new-window failed with exit code ${exitCode}`);
    }
  } catch (error) {
    throw new Error(
      `Failed to create tmux window: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Set a user option on a tmux window for ownership tracking
 */
export async function setWindowOption(target: string, option: string, value: string): Promise<void> {
  try {
    const proc = spawn(["tmux", "set-option", "-w", "-t", target, option, value], { stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`tmux set-option failed with exit code ${exitCode}`);
    }
  } catch (error) {
    throw new Error(
      `Failed to set tmux window option: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Find and kill all tmux windows tagged with a specific job ID
 */
export async function killTaggedWindows(jobId: string): Promise<number> {
  try {
    const proc = spawn(
      ["tmux", "list-windows", "-a", "-F", "#{session_name}:#{window_index} #{@mc_job_id}"],
      { stderr: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      return 0;
    }

    let killed = 0;
    for (const target of parseTaggedWindowTargets(output, jobId)) {
      try {
        const pids = await getPaneProcesses(target);
        await killPaneProcesses(pids);
        const killProc = spawn(["tmux", "kill-window", "-t", target], { stderr: "pipe" });
        await killProc.exited;
        killed++;
      } catch {
        // Best-effort: window may already be gone
      }
    }
    return killed;
  } catch {
    return 0;
  }
}

/**
 * Check if a tmux session exists
 */
export async function sessionExists(name: string): Promise<boolean> {
  try {
    const proc = spawn(["tmux", "has-session", "-t", name], { stderr: "pipe" });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Check if a window exists in a session
 */
export async function windowExists(
  session: string,
  window: string
): Promise<boolean> {
  try {
    const target = `${session}:${window}`;
    const proc = spawn(["tmux", "has-session", "-t", target], { stderr: "pipe" });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Get PIDs of all panes within a tmux target (session or window).
 * Returns an array of PIDs. Best-effort — returns empty on failure.
 */
async function getPaneProcesses(target: string): Promise<number[]> {
  try {
    const proc = spawn(
      ["tmux", "list-panes", "-t", target, "-F", "#{pane_pid}"],
      { stderr: "pipe" },
    );
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return [];

    return output
      .trim()
      .split('\n')
      .map((line) => parseInt(line.trim(), 10))
      .filter((pid) => !isNaN(pid) && pid > 0);
  } catch {
    return [];
  }
}

/**
 * Kill processes running inside tmux panes before destroying them.
 * Sends SIGTERM first, waits briefly, then SIGKILL for survivors.
 * This prevents orphaned processes (e.g., opencode ignoring SIGHUP from tmux).
 */
async function killPaneProcesses(pids: number[]): Promise<void> {
  if (pids.length === 0) return;

  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }

  await new Promise((resolve) => setTimeout(resolve, 500));

  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

/**
 * Kill a tmux session.
 * Kills pane processes first to prevent orphans — opencode ignores SIGHUP
 * from tmux, so kill-session alone leaves zombie processes consuming CPU.
 */
export async function killSession(name: string): Promise<void> {
  const pids = await getPaneProcesses(name);
  const killedProcesses = pids.length > 0;
  await killPaneProcesses(pids);

  try {
    const proc = spawn(["tmux", "kill-session", "-t", name], { stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      // Tolerate failure only if we killed pane processes (session may have auto-closed)
      if (!killedProcesses) {
        throw new Error(`tmux kill-session failed with exit code ${exitCode}`);
      }
    }
  } catch (error) {
    throw new Error(
      `Failed to kill tmux session: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Kill a window in a tmux session.
 * First kills pane processes to prevent orphans (see killSession).
 */
export async function killWindow(
  session: string,
  window: string
): Promise<void> {
  const target = `${session}:${window}`;
  const pids = await getPaneProcesses(target);
  const killedProcesses = pids.length > 0;
  await killPaneProcesses(pids);

  try {
    const proc = spawn(["tmux", "kill-window", "-t", target], { stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      if (!killedProcesses) {
        throw new Error(`tmux kill-window failed with exit code ${exitCode}`);
      }
    }
  } catch (error) {
    throw new Error(
      `Failed to kill tmux window: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Capture pane output
 */
export async function capturePane(
  target: string,
  lines?: number
): Promise<string> {
  try {
    const args = ["capture-pane", "-t", target, "-p"];
    if (lines !== undefined && lines > 0) {
      args.push(`-S-${lines}`);
    }

    const proc = spawn(["tmux", ...args], { stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new Error(`tmux capture-pane failed with exit code ${exitCode}`);
    }

    return output;
  } catch (error) {
    throw new Error(
      `Failed to capture pane: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function sendKeys(target: string, keys: string): Promise<void> {
  try {
    const proc = spawn(["tmux", "send-keys", "-t", target, keys], { stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`tmux send-keys failed with exit code ${exitCode}`);
    }
  } catch (error) {
    throw new Error(
      `Failed to send keys: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Set a pane-died hook
 */
export async function setPaneDiedHook(
  target: string,
  callback: string
): Promise<void> {
  try {
    const proc = spawn([
      "tmux",
      "set-hook",
      "-t",
      target,
      "pane-died",
      callback,
    ], { stderr: "pipe" });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`tmux set-hook failed with exit code ${exitCode}`);
    }
  } catch (error) {
    throw new Error(
      `Failed to set pane-died hook: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Get the PID of a tmux pane
 */
export async function getPanePid(
  target: string
): Promise<number | undefined> {
  try {
    const proc = spawn([
      "tmux",
      "display-message",
      "-t",
      target,
      "-p",
      "#{pane_pid}",
    ], { stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return undefined;
    }

    const pid = parseInt(output.trim(), 10);
    return isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

/** Stderr patterns that indicate the pane/session genuinely does not exist */
const PANE_NOT_FOUND_PATTERNS = [
  "can't find pane",
  "no such session",
  "session not found",
  "window not found",
  "can't find window",
  "no current target",
  "no server running",
];

function isPaneNotFoundError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return PANE_NOT_FOUND_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Check if a tmux pane is running.
 * Returns false when pane genuinely doesn't exist. Throws on tmux infrastructure failures.
 * Retries once (500ms delay) to handle transient errors.
 */
export async function isPaneRunning(target: string): Promise<boolean> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    try {
      const proc = spawn([
        "tmux",
        "display-message",
        "-t",
        target,
        "-p",
        "#{pane_dead}",
      ], { stderr: "pipe" });
      const [output, stderrBuf] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stderr = stderrBuf.trim();
        if (isPaneNotFoundError(stderr)) {
          return false;
        }
        // Unknown tmux error — store and retry
        lastError = new Error(
          `tmux display-message failed (exit ${exitCode}): ${stderr || "(no stderr)"}`,
        );
        continue;
      }

      const outputStr = output.trim();
      if (!outputStr || outputStr === "") {
        return false;
      }

      // pane_dead returns 1 if dead, 0 if running
      const isDead = outputStr === "1";
      return !isDead;
    } catch (error) {
      lastError = error instanceof Error
        ? error
        : new Error(String(error));
      continue;
    }
  }

  // Both attempts failed with a non-"pane not found" error — propagate
  throw lastError ?? new Error("isPaneRunning failed after retries");
}

/**
 * Check if the tmux server is responsive
 */
export async function isTmuxHealthy(): Promise<boolean> {
  try {
    const proc = spawn(["tmux", "list-sessions"], { stderr: "pipe", stdout: "pipe" });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Capture the exit status of a dead tmux pane
 * Returns the exit code if available, or undefined if pane is still running or status unavailable
 */
export async function captureExitStatus(target: string): Promise<number | undefined> {
  try {
    // Try to get pane_dead_status (exit code of dead pane)
    const proc = spawn([
      "tmux",
      "display-message",
      "-t",
      target,
      "-p",
      "#{pane_dead_status}",
    ], { stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return undefined;
    }

    const outputStr = output.trim();
    if (!outputStr || outputStr === "") {
      return undefined;
    }

    // pane_dead_status returns the exit code as a string, or empty if pane is running
    const status = parseInt(outputStr, 10);
    return isNaN(status) ? undefined : status;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Ownership helpers for the kill guard (pure, no tmux calls).
// The integrador uses these in the orchestrator relaunch/teardown paths so a
// kill is issued ONLY for the recorded predecessor — never for a same-name
// foreign session presumed by prefix similarity (revisão §7). Name similarity
// (`mc-<job>`) is not possession; strict equality with the recorded
// tmuxTarget (or an explicit job-tag match) is.
// ---------------------------------------------------------------------------

/** Session prefix for worker sessions (naming only, never proof of ownership). */
export const MC_SESSION_PREFIX = 'mc-';

/** tmux window option carrying the owning job id (see killTaggedWindows). */
export const MC_JOB_TAG_OPTION = '@mc_job_id';

/** Naming check only: does the session name carry the worker prefix? */
export function isMcSessionName(name: string): boolean {
  return name.startsWith(MC_SESSION_PREFIX) && name.length > MC_SESSION_PREFIX.length;
}

/**
 * Pure parser for `tmux list-windows -a -F "#{session}:#{index} #{@mc_job_id}"`.
 * Returns targets whose tag equals jobId. Ownership = tag match.
 */
export function parseTaggedWindowTargets(listOutput: string, jobId: string): string[] {
  const out: string[] = [];
  for (const line of listOutput.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [target, taggedId] = trimmed.split(' ', 2);
    if (taggedId === jobId && target) out.push(target);
  }
  return out;
}

/** Execution tag scoping one session per plan+job run (never the bare job name). */
export function formatExecTag(planId: string, jobId: string): string {
  return `${planId.slice(0, 8)}-${jobId.slice(0, 8)}`;
}

/** Session name for a job, optionally scoped by the execution tag. */
export function sessionNameForJob(sanitizedName: string, execTag?: string): string {
  return execTag ? `mc-${sanitizedName}-${execTag}` : `mc-${sanitizedName}`;
}

/** True only when the session name carries this run's execution tag. */
export function isOwnedSessionForExecTag(sessionName: string, execTag: string): boolean {
  return sessionName.endsWith(`-${execTag}`);
}

/**
 * Strict ownership: a candidate may be killed only when it IS the recorded
 * target. Covers both session (`mc-…`) and window (`session:window`) forms.
 * Anything else — including a legacy bare `mc-<job>` that merely shares the
 * prefix — is foreign and must not be killed.
 */
export function isOwnedTmuxTarget(
  candidate: string | undefined,
  recordedTarget: string | undefined,
): boolean {
  if (!candidate || !recordedTarget) return false;
  return candidate === recordedTarget;
}

/**
 * Keep only candidates that equal the recorded target (deduplicated).
 * No recorded target → no owned kills, never fall back to a name match.
 */
export function filterOwnedKillTargets(
  candidates: Array<string | undefined>,
  recordedTarget: string | undefined,
): string[] {
  if (!recordedTarget) return [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (typeof c !== 'string' || !c) continue;
    if (c === recordedTarget && !seen.has(c)) seen.add(c);
  }
  return [...seen];
}

export interface OwnedKillListInput {
  /** Recorded predecessor from the plan/job state (the only owned kill). */
  previousTarget?: string;
  /** Legacy bare `mc-<job>` name (pre-upgrade). Killed only on explicit opt-in. */
  legacySessionName?: string;
  /**
   * Explicit migration opt-in: when there is NO recorded predecessor, kill
   * the legacy name. Default false — similarity alone never grants ownership.
   * shortcut: remove once all lanes record per-execution targets; upgrade to a
   * tag-based (@mc_job_id) lookup when sessions outlive the plan record.
   */
  allowLegacyFallback?: boolean;
}

/**
 * Owned kill list for relaunch/teardown: the recorded predecessor only.
 * The legacy bare name is returned solely when there is no recorded
 * predecessor AND the caller explicitly opts into the migration fallback.
 */
export function buildOwnedKillList(input: OwnedKillListInput): string[] {
  if (input.previousTarget) return [input.previousTarget];
  if (input.allowLegacyFallback && input.legacySessionName) return [input.legacySessionName];
  return [];
}
