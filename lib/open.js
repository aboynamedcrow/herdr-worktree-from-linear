import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseContextCwd } from './repo.js';
import { callJson, callVoid, notificationArgs } from './native.js';
import { openPickerArgs, swapDirectionFor, parsePaneId, readPlacement, readPopupSize } from './pane.js';
import { runCmd } from './exec.js';

export function openPicker(env = process.env, exec = runCmd) {
  const herdr = env.HERDR_BIN_PATH || 'herdr';
  let context;
  try { context = JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON); } catch {
    throw new Error('worktree-from-linear: explicit invoking pane context is required');
  }
  const paneId = context?.focused_pane_id;
  const workspaceId = context?.workspace_id;
  const cwd = parseContextCwd(env.HERDR_PLUGIN_CONTEXT_JSON);
  if (typeof paneId !== 'string' || !paneId || typeof workspaceId !== 'string' || !workspaceId
      || typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new Error('worktree-from-linear: invoking workspace, pane and checkout are required');
  }
  const live = callJson(exec, herdr, ['pane', 'get', paneId], { timeoutMs: 5000 });
  if (!live.ok) throw new Error(live.error);
  const pane = live.result.pane;
  const actual = pane?.foreground_cwd || pane?.cwd;
  if (pane?.pane_id !== paneId || pane?.workspace_id !== workspaceId
      || typeof actual !== 'string' || realpathSync(actual) !== realpathSync(cwd)) {
    throw new Error('worktree-from-linear: invoking pane changed; invoke the action again');
  }
  const placement = readPlacement(env.HERDR_PLUGIN_CONFIG_DIR);
  const size = readPopupSize(env.HERDR_PLUGIN_CONFIG_DIR);
  const args = openPickerArgs('tdi.worktree-from-linear', cwd, placement, { ...size, targetPane: paneId });
  const result = exec(herdr, args, { env, timeout: 30000 });
  if (!result || result.status !== 0) throw new Error(`worktree-from-linear: could not open picker: ${result?.stderr || 'native command failed'}`);
  const swap = swapDirectionFor(placement);
  if (swap) {
    const opened = parsePaneId(result.stdout);
    if (!opened) throw new Error('worktree-from-linear: picker opened without a pane id; no placement adjustment attempted');
    const moved = callVoid(exec, herdr, ['pane', 'swap', '--direction', swap, '--pane', opened], { timeoutMs: 5000 });
    if (!moved.ok) throw new Error(moved.error);
  }
  return result;
}

export function reportOpenFailure(error, env = process.env, exec = runCmd) {
  return callVoid(exec, env.HERDR_BIN_PATH || 'herdr',
    notificationArgs('Worktree from Linear', String(error.message).slice(0, 1000)), { timeoutMs: 5000 });
}
