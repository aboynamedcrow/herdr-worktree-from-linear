import { loadConfig } from './config.js';
import { parseContextCwd, resolveRepo } from './repo.js';
import { listIssues } from './linear.js';
import { resolveBase } from './base.js';
import { createOrOpenWorktree } from './worktree.js';
import { deliverIssueDetails } from './slot.js';
import { callVoid, notificationArgs } from './native.js';
import { select as defaultSelect } from './picker.js';
import { runCmd } from './exec.js';
import { parseWorkspaceId, reportIssue } from './metadata.js';

// The picker pane closes as soon as this process exits, so a failed delivery would
// otherwise scroll past in a pane that is already gone. The log line is the record; the
// notification is what the user actually sees. Best effort by design — an older server
// without it must not turn a successful worktree into a failure.
function report(message, { exec, herdrBin, log }) {
  log(message);
  callVoid(exec, herdrBin, notificationArgs('Worktree from Linear', message));
}

// Where the worktree lands. `repos` maps a Linear team key to a repo root, so a pick
// routes by the issue's team rather than by whichever pane happened to invoke the
// action. Teams absent from the map fall back to the invoking pane's repo, which is
// also the whole behaviour when no map is configured.
export function repoRootFor(config, issue, env, exec = runCmd) {
  const mapped = config.repos && typeof config.repos === 'object' ? config.repos[issue.teamKey] : null;
  if (typeof mapped === 'string' && mapped) return mapped;
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
  log = (m) => process.stdout.write(`${m}\n`),
  warn = (m) => process.stderr.write(`${m}\n`),
} = {}) {
  const invokingRoot = env.HERDR_WFP_CWD || parseContextCwd(env.HERDR_PLUGIN_CONTEXT_JSON, env.PWD || process.cwd());
  const config = loadConfig(env.HERDR_PLUGIN_CONFIG_DIR, invokingRoot, env);
  const issues = await listIssues(config, fetchFn);
  if (issues.length === 0) {
    log('worktree-from-linear: no active issues');
    return 0;
  }
  const issue = await select(issues, { exec, layout: config.fzfLayout });
  if (!issue) {
    log('worktree-from-linear: cancelled');
    return 0;
  }
  if (!issue.branchName) {
    log(`worktree-from-linear: issue ${issue.identifier} has no branch name`);
    return 0;
  }
  // Resolved after the pick, not before: the issue's team is what selects the repo.
  const repoRoot = repoRootFor(config, issue, env, exec);
  const base = resolveBase(repoRoot, config, exec);
  const herdrBin = env.HERDR_BIN_PATH || 'herdr';
  const res = createOrOpenWorktree(repoRoot, issue.branchName, base, exec, herdrBin);
  reportIssue(parseWorkspaceId(res.stdout), issue.identifier, { exec, herdrBin, warn });
  log(`worktree-from-linear: ${res.exists ? 'opened' : 'created'} worktree for ${issue.identifier} (${issue.branchName})`);
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
