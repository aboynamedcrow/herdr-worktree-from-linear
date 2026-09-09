import { loadConfig } from './config.js';
import { validIdentifier } from './hostwire.js';
import { callJson } from './native.js';
import { deliverIssueDetails, readWorktreeWorkspace } from './slot.js';
import { runCmd } from './exec.js';

export function showArgs(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!['--workspace', '--issue'].includes(flag) || values.has(flag)
        || typeof value !== 'string' || !value || /[\x00-\x20\x7f]/.test(value)) {
      throw new Error('usage: show.js --workspace ID --issue IDENTIFIER');
    }
    values.set(flag, value);
  }
  if (!values.has('--workspace') || (!validIdentifier(values.get('--issue')) || !/-[1-9][0-9]*$/.test(values.get('--issue')))) {
    throw new Error('usage: show.js --workspace ID --issue IDENTIFIER');
  }
  return { workspaceId: values.get('--workspace'), identifier: values.get('--issue') };
}

export async function showIssue(args, { env = process.env, exec = runCmd, deliver = deliverIssueDetails } = {}) {
  const { workspaceId, identifier } = showArgs(args);
  const herdrBin = env.HERDR_BIN_PATH || 'herdr';
  const result = callJson(exec, herdrBin, ['workspace', 'get', workspaceId], { timeoutMs: 5000 });
  if (!result.ok) throw new Error(result.error);
  if (result.result.workspace?.workspace_id !== workspaceId) throw new Error('worktree-from-linear: native workspace identity changed');
  const stdout = JSON.stringify({ result: result.result });
  const workspace = readWorktreeWorkspace(stdout);
  if (!workspace.ok) throw new Error(workspace.error);
  const config = loadConfig(env.HERDR_PLUGIN_CONFIG_DIR, workspace.checkoutPath, env, identifier);
  const delivered = await deliver({ worktreeStdout: stdout, identifier, config,
    configDir: env.HERDR_PLUGIN_CONFIG_DIR, socketPath: env.HERDR_SOCKET_PATH, exec, herdrBin });
  if (!delivered.ok) throw new Error(`worktree-from-linear: issue details not delivered — ${delivered.error}`);
  return 0;
}
