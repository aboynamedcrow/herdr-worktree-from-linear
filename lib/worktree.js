import { accessSync, constants, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { runCmd } from './exec.js';
import { readWorktreeWorkspace } from './slot.js';

const PLUS = 'cloudmanic.herdr-plus';
const DIGEST = /^[a-f0-9]{64}$/;
const text = (value) => typeof value === 'string' && value.length > 0 && !/[\x00-\x1f]/.test(value);
const absolute = (value) => text(value) && isAbsolute(value);

function command(exec, binary, args, env, timeout = 10000) {
  const result = exec(binary, args, { env, timeout, maxBuffer: 4 * 1024 * 1024 });
  if (!result || result.status !== 0) {
    throw new Error(`worktree-from-linear: ${args[0]} failed: ${String(result?.stderr || 'command unavailable').trim().slice(0, 1000)}`);
  }
  return result.stdout;
}

function parseJson(value, label) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error(`worktree-from-linear: invalid ${label} JSON`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.error) {
    throw new Error(`worktree-from-linear: invalid ${label} reply`);
  }
  return parsed;
}

// Discover the installed backend and its own configuration. The Linear picker
// runs in a different plugin directory and must not pass its config to Plus.
export function discoverPlus(env = process.env, exec = runCmd) {
  const herdr = env.HERDR_BIN_PATH || 'herdr';
  const inventory = parseJson(command(exec, herdr, ['plugin', 'list', '--plugin', PLUS, '--json'], env), 'Plus inventory');
  const plugins = inventory.result?.plugins;
  if (!Array.isArray(plugins) || plugins.length !== 1 || plugins[0]?.plugin_id !== PLUS
      || plugins[0]?.enabled !== true || !absolute(plugins[0]?.plugin_root)) {
    throw new Error('worktree-from-linear: install and enable the reviewed Herdr Plus worktree backend');
  }
  const root = realpathSync(plugins[0].plugin_root);
  const binary = realpathSync(join(root, 'bin', 'herdr-plus'));
  const inside = relative(root, binary);
  if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('worktree-from-linear: Plus executable is outside its plugin directory');
  accessSync(binary, constants.X_OK);
  const config = command(exec, herdr, ['plugin', 'config-dir', PLUS], env).trim();
  if (!absolute(config)) throw new Error('worktree-from-linear: Plus returned no absolute config directory');
  return { binary, env: { ...env, HERDR_PLUGIN_CONFIG_DIR: config } };
}

export function readWorktreePlan(stdout) {
  const plan = parseJson(stdout, 'worktree plan');
  if (plan.version !== 1 || !DIGEST.test(plan.fingerprint) || !text(plan.project)
      || !absolute(plan.repository) || !Array.isArray(plan.candidates) || plan.candidates.length === 0) {
    throw new Error('worktree-from-linear: unsupported or incomplete Plus worktree plan');
  }
  const ids = new Set();
  for (const candidate of plan.candidates) {
    if (!candidate || !DIGEST.test(candidate.id) || ids.has(candidate.id)
        || !text(candidate.branch) || !absolute(candidate.path)
        || typeof candidate.existing !== 'boolean' || typeof candidate.checkout !== 'boolean'
        || (candidate.checkout && !candidate.existing)) {
      throw new Error('worktree-from-linear: invalid or duplicate Plus worktree choice');
    }
    ids.add(candidate.id);
  }
  return plan;
}

export function planIssueWorktree(repoRoot, issue, { env = process.env, exec = runCmd } = {}) {
  if (!absolute(repoRoot) || !/^[A-Za-z][A-Za-z0-9]*-[1-9][0-9]*$/.test(issue?.identifier)
      || !text(issue?.title)) throw new Error('worktree-from-linear: issue identifier, title and checkout are required');
  const backend = discoverPlus(env, exec);
  const args = ['--cwd', repoRoot, '--name', issue.title, '--issue', issue.identifier];
  const plan = readWorktreePlan(command(exec, backend.binary, ['plan-worktree', ...args], backend.env, 60000));
  if (plan.issue !== issue.identifier.toUpperCase()) throw new Error('worktree-from-linear: Plus planned another issue');
  return { backend, args, plan };
}

export function applyIssueWorktree(planned, candidate, exec = runCmd) {
  // The picker returns an id, never its own branch/path inference.
  const choice = planned.plan.candidates.find((entry) => entry.id === candidate?.id);
  if (!choice) throw new Error('worktree-from-linear: select a choice from the current worktree plan');
  const stdout = command(exec, planned.backend.binary, ['apply-worktree', ...planned.args,
    '--candidate', choice.id, '--fingerprint', planned.plan.fingerprint], planned.backend.env, 240000);
  const reply = parseJson(stdout, 'worktree apply');
  const workspace = readWorktreeWorkspace(stdout);
  if (!workspace.ok || reply.result?.worktree?.branch !== choice.branch) {
    throw new Error('worktree-from-linear: Plus returned a different or incomplete worktree; inspect the result before retrying');
  }
  const canonical = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
  if (canonical(workspace.checkoutPath) !== canonical(choice.path)) {
    throw new Error('worktree-from-linear: Plus returned another checkout; inspect the result before retrying');
  }
  return { stdout, branchName: choice.branch, exists: choice.checkout };
}
