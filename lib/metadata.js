import { runCmd } from './exec.js';

const SOURCE = 'plugin:tdi.worktree-from-linear';

// herdr caps token values at 80 characters; stay well inside it.
const MAX_VALUE = 80;

export function findWorkspaceId(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 4) return null;
  for (const key of ['workspace_id', 'open_workspace_id']) {
    const value = node[key];
    if (typeof value === 'string' && value) return value;
  }
  for (const value of Object.values(node)) {
    const found = findWorkspaceId(value, depth + 1);
    if (found) return found;
  }
  return null;
}

// The workspace id from `herdr worktree create|open --json` stdout. Both answer with
// result.workspace.workspace_id; the recursive fallback keeps a herdr JSON shape change
// from costing us the label, the way the 0.7.3 shape change cost the worktree listing.
export function parseWorkspaceId(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const direct = parsed?.result?.workspace?.workspace_id;
  if (typeof direct === 'string' && direct) return direct;
  return findWorkspaceId(parsed?.result ?? parsed);
}

export function buildReportArgs(workspaceId, value) {
  return [
    'workspace', 'report-metadata', workspaceId,
    '--source', SOURCE,
    '--token', `linear=${value}`,
  ];
}

// Display-only: no TTL, so the token lives as long as the workspace does. Never throws
// and never changes the caller's exit code — a sidebar label is not worth failing a
// worktree over. Needs herdr 0.7.4+; older herdr rejects the subcommand and we warn.
export function reportIssue(workspaceId, identifier, {
  exec = runCmd,
  herdrBin = 'herdr',
  warn = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  if (!workspaceId || !identifier) return false;
  let res;
  try {
    res = exec(herdrBin, buildReportArgs(workspaceId, String(identifier).slice(0, MAX_VALUE)), { timeout: 2000 });
  } catch (error) {
    res = { status: 1, error, stderr: '' };
  }
  if (res.status !== 0) {
    const reason = res.error?.message || res.stderr.trim() || `exit ${res.status}`;
    warn(`worktree-from-linear: sidebar issue label failed: ${reason}`);
    return false;
  }
  return true;
}
