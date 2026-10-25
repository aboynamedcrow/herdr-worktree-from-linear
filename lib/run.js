import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { parseContextCwd, resolveRepo } from './repo.js';
import { listIssues, fetchPickerIssue } from './linear.js';
import { readIssueWorkspace, showIssueInWorkspace } from './show.js';
import { planIssueWorktree, applyIssueWorktree } from './worktree.js';
import { deliverIssueDetails } from './slot.js';
import { callVoid, notificationArgs } from './native.js';
import { select as defaultSelect, selectWorktree as defaultSelectWorktree } from './picker.js';
import { runCmd } from './exec.js';
import { parseWorkspaceId, reportIssue } from './metadata.js';

// The picker pane closes as soon as this process exits, so a failed delivery would
// otherwise scroll past in a pane that is already gone. The log line is the record; the
// notification is what the user actually sees. Best effort by design — an older server
// without it must not turn a successful worktree into a failure — and bounded, so a server
// that accepts the call and never answers cannot hold the picker open either.
const NOTIFY_TIMEOUT_MS = 5000;

function report(message, { exec, herdrBin, log }) {
  log(message);
  callVoid(exec, herdrBin, notificationArgs('Worktree from Linear', message), { timeoutMs: NOTIFY_TIMEOUT_MS });
}

function startAgent(issue, { env, exec, log }) {
  const paneId = env.HERDR_WFP_START_PANE;
  if (typeof paneId !== 'string' || !paneId.trim() || /\s/.test(paneId)) {
    throw new Error('worktree-from-linear: start requires the invoking pane context');
  }
  const task = env.TASK_BIN || join(env.HOME || homedir(), 'dot', 'bin', 'task');
  const taskEnv = Object.fromEntries(Object.entries(env)
    .filter(([name]) => !name.startsWith('HERDR_PLUGIN_') && !name.startsWith('HERDR_WFP_')));
  log(`Starting ${issue.identifier} through task new. This can take minutes.`);
  const result = exec(task, ['new', `${issue.identifier} [M]`], {
    // Allow 3000 seconds for the 2400-second bootstrap wait and the surrounding steps.
    env: { ...taskEnv, HERDR_ENV: '1', HERDR_PANE_ID: paneId }, timeout: 3000000,
  });
  const message = [result?.stdout?.trimEnd(), result?.stderr?.trimEnd()].filter(Boolean).join('\n')
    || (result?.status === 0 ? '' : 'worktree-from-linear: task new failed without a message');
  if (message) report(message, { exec, herdrBin: env.HERDR_BIN_PATH || 'herdr', log });
  return result?.status === 0 ? 0 : 1;
}

// Where the worktree lands. `repos` maps a Linear team key to a repo root, so a pick
// routes by the issue's team rather than by whichever pane happened to invoke the
// action. Teams absent from the map fall back to the invoking pane's repo, which is
// also the whole behaviour when no map is configured.
export function repoRootFor(config, issue, env, exec = runCmd) {
  const mapped = config.repos && typeof config.repos === 'object' ? config.repos[issue.teamKey] : null;
  if (typeof mapped === 'string' && mapped) {
    return resolveRepo({ ...env, HERDR_WFP_CWD: mapped }, exec).repoRoot;
  }
  try {
    return resolveRepo(env, exec).repoRoot;
  } catch (err) {
    if (issue.teamKey) {
      throw new Error(`${err.message} (and team ${issue.teamKey} is not in the "repos" map in config.json)`);
    }
    throw err;
  }
}

export async function run({
  env = process.env,
  exec = runCmd,
  fetchFn = fetch,
  select = defaultSelect,
  selectWorktree = defaultSelectWorktree,
  log = (m) => process.stdout.write(`${m}\n`),
  warn = (m) => process.stderr.write(`${m}\n`),
} = {}) {
  const workspace = env.HERDR_WFP_MODE === 'show'
    ? readIssueWorkspace(env.HERDR_WFP_WORKSPACE, { env, exec }) : null;
  // Key rules match the invoking checkout. Plus plans from the main worktree (repoRootFor).
  let invokingRoot = env.HERDR_WFP_CWD || parseContextCwd(env.HERDR_PLUGIN_CONTEXT_JSON) || null;
  let repoError;
  try { ({ checkoutRoot: invokingRoot } = resolveRepo(env, exec)); } catch (error) { repoError = error; }
  const config = loadConfig(env.HERDR_PLUGIN_CONFIG_DIR, invokingRoot, env);
  if (repoError && !config.repos && !workspace) throw repoError;
  const issues = await listIssues(config, fetchFn);
  if (issues.length === 0) {
    log('worktree-from-linear: no active issues');
  }
  let issue = await select(issues, { exec, layout: config.fzfLayout, idTeamKey: config.idTeamKey, teamKey: config.teamKey });
  if (typeof issue === 'string') {
    const identifier = issue;
    const lookupConfig = loadConfig(env.HERDR_PLUGIN_CONFIG_DIR, invokingRoot, env, identifier);
    issue = await fetchPickerIssue(lookupConfig, identifier, fetchFn);
    if (!issue) {
      report(`worktree-from-linear: issue ${identifier} not found`, { exec, herdrBin: env.HERDR_BIN_PATH || 'herdr', log });
      return 0;
    }
  }
  if (!issue) {
    log('worktree-from-linear: cancelled');
    return 0;
  }
  if (env.HERDR_WFP_MODE === 'start') return startAgent(issue, { env, exec, log });
  if (workspace) {
    try {
      return await showIssueInWorkspace(workspace, issue.identifier, { env, exec });
    } catch (error) {
      report(error.message, { exec, herdrBin: env.HERDR_BIN_PATH || 'herdr', log });
      return 1;
    }
  }
  const repoRoot = repoRootFor(config, issue, env, exec);
  const planned = planIssueWorktree(repoRoot, issue, { env, exec });
  const candidate = await selectWorktree(planned.plan.candidates, { exec, layout: config.fzfLayout,
    remoteState: planned.plan.remote_state });
  if (!candidate) {
    log('worktree-from-linear: cancelled worktree choice');
    return 0;
  }
  const herdrBin = env.HERDR_BIN_PATH || 'herdr';
  const res = applyIssueWorktree(planned, candidate, exec);
  reportIssue(parseWorkspaceId(res.stdout), issue.identifier, { exec, herdrBin, warn });
  log(`worktree-from-linear: ${res.exists ? 'opened' : 'created'} worktree for ${issue.identifier} (${res.branchName})`);
  // Opt-in via showIssueDetails, and now on both paths: delivery targets a slot that is
  // already there instead of adding a pane, so re-opening a worktree cannot stack panes.
  if (config.showIssueDetails) {
    const delivered = await deliverIssueDetails({
      worktreeStdout: res.stdout,
      identifier: issue.identifier,
      config,
      configDir: env.HERDR_PLUGIN_CONFIG_DIR,
      // herdr injects this into every plugin command. Focusing an exact pane has no CLI,
      // so delivery needs the socket the same clients use.
      socketPath: env.HERDR_SOCKET_PATH,
      exec,
      herdrBin,
    });
    // The worktree and its layout are already correct either way, so a delivery failure
    // is reported and the action still succeeds.
    if (!delivered.ok) report(`worktree-from-linear: issue details not delivered — ${delivered.error}`, { exec, herdrBin, log });
  }
  return 0;
}
