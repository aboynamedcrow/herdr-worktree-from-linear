import { isAbsolute } from 'node:path';
import { runCmd } from './exec.js';

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

export function parseContextCwd(contextJson, fallbackCwd) {
  let ctx = null;
  try {
    ctx = contextJson ? JSON.parse(contextJson) : null;
  } catch {
    ctx = null;
  }
  if (ctx && typeof ctx === 'object') {
    const pane = ctx.focused_pane && typeof ctx.focused_pane === 'object' ? ctx.focused_pane : {};
    const workspace = ctx.workspace && typeof ctx.workspace === 'object' ? ctx.workspace : {};
    const worktree = ctx.worktree && typeof ctx.worktree === 'object' ? ctx.worktree : {};
    const found = firstString(
      ctx.focused_pane_cwd, pane.cwd, pane.working_directory,
      ctx.workspace_cwd, workspace.cwd, workspace.path,
      worktree.checkout_path, worktree.path, worktree.workspace_cwd,
      ctx.cwd, ctx.repo_root,
    );
    if (found) return found;
  }
  return fallbackCwd;
}

export function resolveRepo(env, exec = runCmd) {
  const cwd = (typeof env.HERDR_WFP_CWD === 'string' && env.HERDR_WFP_CWD)
    || parseContextCwd(env.HERDR_PLUGIN_CONTEXT_JSON);
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || /[\x00-\x1f]/.test(cwd)) {
    throw new Error('worktree-from-linear: explicit invoking checkout context is required');
  }
  const gitEnv = { ...env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_GRAFT_FILE',
    'GIT_SHALLOW_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_NO_REPLACE_OBJECTS',
    'GIT_IMPLICIT_WORK_TREE', 'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES',
    'GIT_DISCOVERY_ACROSS_FILESYSTEM']) delete gitEnv[name];
  const top = exec('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { env: gitEnv, timeout: 10000 });
  if (top.status !== 0) {
    throw new Error('worktree-from-linear: not inside a git repository');
  }
  const repoRoot = top.stdout.trim();
  if (!isAbsolute(repoRoot) || /[\x00-\x1f]/.test(repoRoot)) throw new Error('worktree-from-linear: invalid Git checkout reply');
  return { repoRoot };
}
