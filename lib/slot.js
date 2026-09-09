// Deliver the issue viewer into a slot the user already laid out.
//
// The old behavior split the new workspace and swapped the details pane up, which
// rearranged a layout the user (or their layout file) had already decided. This module
// replaces that: it finds the one pane the config names, proves that pane is sitting at
// an idle shell prompt, and types a command into it. It never creates, moves, swaps,
// resizes or closes anything. When the slot is missing, renamed, duplicated, busy or
// simply unreadable, delivery fails with a diagnostic and the worktree and its layout
// are left exactly as herdr made them.
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { runCmd } from './exec.js';
import {
  callJson, callVoid, paneFocusArgs, paneGetArgs, paneListArgs, paneProcessInfoArgs,
  paneRunArgs, reportMetadataArgs, tabListArgs,
} from './native.js';

// The metadata source and token names the viewer publishes on its own pane. `source`
// scopes the tokens to this plugin so another reporter cannot overwrite them, and the
// token names are within herdr's [A-Za-z0-9_-]{1,32}.
export const METADATA_SOURCE = 'tdi.worktree-from-linear';
export const ISSUE_TOKEN = 'wfl-issue';
export const INVOCATION_TOKEN = 'wfl-invocation';

// Layout is applied asynchronously after `worktree create|open` returns, so the slot may
// not exist yet on the first look. Both bounds are finite: the poll gives up rather than
// waiting on a layout that is never coming.
const DEFAULT_SETTLE_MS = 5000;
const DEFAULT_POLL_MS = 200;
const MAX_SETTLE_MS = 60000;

// A slot is only writable when the shell itself is in the foreground. Anything not on
// this list is treated as unknown and refused — an agent, a pager or a half-recognized
// process must never be typed into.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'ksh93', 'mksh', 'tcsh', 'csh']);

// The viewer's script, resolved once from this module's own location so the command line
// never depends on the shell's cwd or on how herdr invoked the plugin.
export const VIEWER_SCRIPT = fileURLToPath(new URL('../bin/issue.js', import.meta.url));

// Single-quote for POSIX shells: everything inside '' is literal, and an embedded quote
// is closed, escaped and reopened. The identifier is already validated upstream, but the
// command line is user-visible shell input — quote every argument, not just the risky one.
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Reject anything that cannot survive being typed at a prompt. A newline would submit a
// second command; a NUL or control character would be silently mangled by the tty.
function typable(value) {
  return typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

// The exact command line the slot's shell runs. Absolute node, absolute script, absolute
// config dir and cwd: the shell's own PATH, cwd and NODE_OPTIONS must not be able to
// change which viewer starts. --issue and --invocation are the observable identity that
// a later delivery reads back out of the live process's argv.
export function buildViewerCommand(spec) {
  const { nodePath, scriptPath, identifier, invocation, configDir, cwd, paneId } = spec;
  const parts = [nodePath, scriptPath, '--issue', identifier, '--invocation', invocation];
  if (configDir) parts.push('--config-dir', configDir);
  if (cwd) parts.push('--cwd', cwd);
  if (paneId) parts.push('--pane', paneId);
  for (const part of parts) {
    if (!typable(part)) return { ok: false, error: 'issue viewer arguments are not safe to type' };
  }
  // Flags are constants, but quoting uniformly keeps one rule instead of two.
  return { ok: true, command: parts.map(shellQuote).join(' ') };
}

function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

// Strip zsh's login-shell leading dash and any directory, so "-zsh" and "/bin/zsh" both
// read as "zsh".
function baseName(value) {
  return String(value || '').replace(/^-/, '').split('/').pop();
}

// What is actually in front of the tty right now.
//
// `pane get`'s agent fields describe what herdr believes occupies the pane, which is not
// the same question: a pane can carry agent metadata while its shell sits idle, and a
// pane with no agent metadata can be running anything. Only the foreground process list
// answers "is this shell free".
export function classifyForeground(processInfo, paneId, scriptPath = VIEWER_SCRIPT) {
  if (!processInfo || typeof processInfo !== 'object') {
    return { kind: 'unknown', detail: 'no process information' };
  }
  if (processInfo.pane_id !== paneId) {
    return { kind: 'unknown', detail: `process information is for ${processInfo.pane_id ?? 'another pane'}` };
  }
  const procs = processInfo.foreground_processes;
  if (!Array.isArray(procs) || procs.length === 0) {
    return { kind: 'unknown', detail: 'no foreground process reported' };
  }
  if (procs.length > 1) {
    return { kind: 'busy', detail: `${procs.length} foreground processes` };
  }
  const proc = procs[0];
  if (!proc || typeof proc !== 'object' || typeof proc.pid !== 'number') {
    return { kind: 'unknown', detail: 'malformed foreground process' };
  }
  // Our own viewer first: it runs as node, so its pid is never the shell's.
  const argv = Array.isArray(proc.argv) ? proc.argv.map(String) : [];
  if (argv.includes(scriptPath)) {
    return {
      kind: 'viewer',
      issue: flagValue(argv, '--issue'),
      invocation: flagValue(argv, '--invocation'),
      detail: 'issue viewer',
    };
  }
  // "The shell is in the foreground" means the foreground process IS the shell process,
  // not merely a process that shares its name. A remembered pid is not enough either:
  // the process group must be the shell's own, or something is running under it.
  const shellPid = processInfo.shell_pid;
  if (typeof shellPid !== 'number' || proc.pid !== shellPid) {
    return { kind: 'busy', detail: `${proc.name || 'a process'} is running` };
  }
  const group = processInfo.foreground_process_group_id;
  if (typeof group === 'number' && group !== shellPid) {
    return { kind: 'busy', detail: 'a job holds the foreground process group' };
  }
  const name = baseName(proc.name || proc.argv0);
  if (!SHELLS.has(name)) {
    return { kind: 'unknown', detail: `unrecognized foreground process ${name || 'with no name'}` };
  }
  return { kind: 'shell', detail: name };
}

// The workspace to work in, taken from the reply that created or opened it. Never from
// the focused pane: another client's focus is not this worktree.
export function readWorktreeWorkspace(stdout) {
  let result;
  try {
    result = JSON.parse(stdout)?.result;
  } catch {
    return { ok: false, error: 'herdr worktree reply was unparseable' };
  }
  const workspaceId = result?.workspace?.workspace_id;
  if (typeof workspaceId !== 'string' || !workspaceId) {
    return { ok: false, error: 'herdr worktree reply carried no workspace id' };
  }
  // The reply also names the tab and root pane it made. If those disagree about which
  // workspace they belong to, the reply is not describing one coherent workspace and no
  // id in it can be trusted as a delivery target.
  for (const [field, value] of [['tab', result.tab], ['root pane', result.root_pane]]) {
    if (value && value.workspace_id !== workspaceId) {
      return { ok: false, error: `herdr worktree reply's ${field} belongs to ${value.workspace_id}` };
    }
  }
  const path = typeof result?.worktree?.path === 'string' ? result.worktree.path : null;
  return { ok: true, workspaceId, checkoutPath: path || result?.workspace?.worktree?.checkout_path || null };
}

// Exactly one tab with the configured label, and inside it exactly one pane with the
// configured label. Duplicates are refused rather than guessed at: two panes named
// "Issue / Utility" means the user's layout is not what the config describes, and picking
// one of them would type into a pane at random.
export function selectSlot(tabs, panes, workspaceId, tabLabel, paneLabel) {
  if (!Array.isArray(tabs)) return { ok: false, error: 'herdr tab list returned no tabs' };
  if (!Array.isArray(panes)) return { ok: false, error: 'herdr pane list returned no panes' };
  const matchedTabs = tabs.filter((t) => t && t.workspace_id === workspaceId && t.label === tabLabel);
  if (matchedTabs.length === 0) {
    return { ok: false, error: `no tab labeled ${JSON.stringify(tabLabel)} in ${workspaceId}` };
  }
  if (matchedTabs.length > 1) {
    const ids = matchedTabs.map((t) => t.tab_id).join(', ');
    return { ok: false, error: `${matchedTabs.length} tabs labeled ${JSON.stringify(tabLabel)} in ${workspaceId} (${ids})` };
  }
  const tab = matchedTabs[0];
  if (typeof tab.tab_id !== 'string' || !tab.tab_id) {
    return { ok: false, error: `tab labeled ${JSON.stringify(tabLabel)} has no id` };
  }
  const matchedPanes = panes.filter((p) => (
    p && p.workspace_id === workspaceId && p.tab_id === tab.tab_id && p.label === paneLabel
  ));
  if (matchedPanes.length === 0) {
    return { ok: false, error: `no pane labeled ${JSON.stringify(paneLabel)} in ${tab.tab_id}` };
  }
  if (matchedPanes.length > 1) {
    const ids = matchedPanes.map((p) => p.pane_id).join(', ');
    return { ok: false, error: `${matchedPanes.length} panes labeled ${JSON.stringify(paneLabel)} in ${tab.tab_id} (${ids})` };
  }
  const pane = matchedPanes[0];
  if (typeof pane.pane_id !== 'string' || !pane.pane_id) {
    return { ok: false, error: `pane labeled ${JSON.stringify(paneLabel)} has no id` };
  }
  return { ok: true, tabId: tab.tab_id, paneId: pane.pane_id };
}

function positiveInt(value, fallback, max) {
  return Number.isInteger(value) && value > 0 && value <= max ? value : fallback;
}

// Both labels must be configured explicitly. There is no default slot name: this plugin
// ships to other people's layouts, and a guessed label would type into whatever pane a
// stranger happened to call the same thing.
export function slotSettings(config = {}) {
  const tabLabel = config.issueTabLabel;
  const paneLabel = config.issuePaneLabel;
  const missing = [
    (typeof tabLabel !== 'string' || !tabLabel) && 'issueTabLabel',
    (typeof paneLabel !== 'string' || !paneLabel) && 'issuePaneLabel',
  ].filter(Boolean);
  if (missing.length) {
    return { ok: false, error: `showIssueDetails needs ${missing.join(' and ')} in config.json` };
  }
  const settleMs = positiveInt(config.issueSlotSettleMs, DEFAULT_SETTLE_MS, MAX_SETTLE_MS);
  return {
    ok: true,
    tabLabel,
    paneLabel,
    settleMs,
    pollMs: Math.min(positiveInt(config.issueSlotPollMs, DEFAULT_POLL_MS, MAX_SETTLE_MS), settleMs),
  };
}

function newInvocation() {
  return randomBytes(8).toString('hex');
}

// Read the tokens the viewer published on its pane. Absent tokens are not an error here:
// the caller decides what their absence means.
function paneTokens(exec, herdrBin, paneId) {
  const got = callJson(exec, herdrBin, paneGetArgs(paneId));
  if (!got.ok) return { ok: false, error: got.error };
  const pane = got.result.pane;
  if (!pane || pane.pane_id !== paneId) {
    return { ok: false, error: `herdr pane get answered for ${pane?.pane_id ?? 'another pane'}` };
  }
  const tokens = pane.tokens && typeof pane.tokens === 'object' ? pane.tokens : {};
  return { ok: true, tokens, workspaceId: pane.workspace_id, tabId: pane.tab_id, label: pane.label ?? null };
}

// One inventory pass: tab list + pane list + the uniqueness rules.
function inspect(exec, herdrBin, workspaceId, tabLabel, paneLabel) {
  const tabs = callJson(exec, herdrBin, tabListArgs(workspaceId));
  if (!tabs.ok) return { ok: false, error: tabs.error };
  const panes = callJson(exec, herdrBin, paneListArgs(workspaceId));
  if (!panes.ok) return { ok: false, error: panes.error };
  return selectSlot(tabs.result.tabs, panes.result.panes, workspaceId, tabLabel, paneLabel);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Show `identifier` in the configured slot of the workspace the worktree reply names.
 *
 * Returns { ok: true, action: 'launched' | 'focused', paneId } or { ok: false, error }.
 * Every failure path is a report, never a repair: nothing in here opens, moves or closes
 * a pane, so a refusal leaves the worktree and the layout the user already has.
 */
export async function deliverIssueDetails({
  worktreeStdout,
  identifier,
  config = {},
  configDir,
  exec = runCmd,
  herdrBin = 'herdr',
  nodePath = process.execPath,
  scriptPath = VIEWER_SCRIPT,
  sleep = wait,
  now = Date.now,
  invocation = newInvocation,
} = {}) {
  const settings = slotSettings(config);
  if (!settings.ok) return { ok: false, error: settings.error };
  if (!typable(identifier)) return { ok: false, error: 'issue identifier is not safe to deliver' };

  const workspace = readWorktreeWorkspace(worktreeStdout);
  if (!workspace.ok) return { ok: false, error: workspace.error };
  const { workspaceId } = workspace;

  // Wait out the asynchronous layout, but only for the configured deadline. A failed or
  // malformed inventory is retried too — layout application is exactly when a tab can be
  // half-built — and whatever the last look said becomes the diagnostic if time runs out.
  const deadline = now() + settings.settleMs;
  let found = inspect(exec, herdrBin, workspaceId, settings.tabLabel, settings.paneLabel);
  while (!found.ok && now() < deadline) {
    await sleep(settings.pollMs);
    found = inspect(exec, herdrBin, workspaceId, settings.tabLabel, settings.paneLabel);
  }
  if (!found.ok) return { ok: false, error: found.error };
  const { paneId, tabId } = found;

  const before = callJson(exec, herdrBin, paneProcessInfoArgs(paneId));
  if (!before.ok) return { ok: false, error: before.error };
  const state = classifyForeground(before.result.process_info, paneId, scriptPath);

  if (state.kind === 'viewer') {
    // A viewer is already there. It is *this* issue's viewer only when the live argv and
    // the pane's published tokens agree with each other and with what we were asked to
    // show. Tokens alone prove nothing — they outlive the process that wrote them — and
    // argv alone cannot tell a viewer we launched from one someone else started.
    const meta = paneTokens(exec, herdrBin, paneId);
    if (!meta.ok) return { ok: false, error: meta.error };
    if (meta.workspaceId !== workspaceId || meta.tabId !== tabId || meta.label !== settings.paneLabel) {
      return { ok: false, error: `slot ${paneId} no longer matches the configured slot` };
    }
    const agrees = state.issue === identifier
      && typeof state.invocation === 'string' && state.invocation !== ''
      && meta.tokens[ISSUE_TOKEN] === identifier
      && meta.tokens[INVOCATION_TOKEN] === state.invocation;
    if (!agrees) {
      const other = state.issue && state.issue !== identifier ? ` for ${state.issue}` : '';
      return { ok: false, error: `slot ${paneId} holds another issue viewer${other}` };
    }
    const focused = callVoid(exec, herdrBin, paneFocusArgs(paneId));
    if (!focused.ok) return { ok: false, error: focused.error };
    return { ok: true, action: 'focused', paneId, issue: identifier, invocation: state.invocation };
  }

  if (state.kind !== 'shell') {
    return { ok: false, error: `slot ${paneId} is not at a shell prompt: ${state.detail}` };
  }

  const token = invocation();
  const built = buildViewerCommand({
    nodePath,
    scriptPath,
    identifier,
    invocation: token,
    configDir: configDir && isAbsolute(configDir) ? configDir : (configDir ? resolve(configDir) : null),
    cwd: workspace.checkoutPath,
    paneId,
  });
  if (!built.ok) return { ok: false, error: built.error };

  // Everything above was read before the command line was built. Look again: the slot may
  // have been renamed, closed or started a job in the meantime, and this is input, not a
  // query. The window between this check and the write cannot be closed from here — it is
  // narrowed, not eliminated.
  const again = inspect(exec, herdrBin, workspaceId, settings.tabLabel, settings.paneLabel);
  if (!again.ok) return { ok: false, error: again.error };
  if (again.paneId !== paneId || again.tabId !== tabId) {
    return { ok: false, error: `slot moved from ${paneId} to ${again.paneId} while preparing` };
  }
  const after = callJson(exec, herdrBin, paneProcessInfoArgs(paneId));
  if (!after.ok) return { ok: false, error: after.error };
  const recheck = classifyForeground(after.result.process_info, paneId, scriptPath);
  if (recheck.kind !== 'shell') {
    return { ok: false, error: `slot ${paneId} stopped being a shell prompt: ${recheck.detail}` };
  }

  const sent = callVoid(exec, herdrBin, paneRunArgs(paneId, built.command));
  if (!sent.ok) return { ok: false, error: sent.error };
  return { ok: true, action: 'launched', paneId, issue: identifier, invocation: token };
}

// Tokens the viewer publishes so a later delivery can recognize it, and the same names
// cleared on the way out. Clearing is best effort: a failure here says the report did not
// land, never that the viewer is still running.
export function viewerMetadataArgs(paneId, identifier, invocation) {
  return reportMetadataArgs(paneId, METADATA_SOURCE, {
    [ISSUE_TOKEN]: identifier,
    [INVOCATION_TOKEN]: invocation,
  });
}

export function viewerMetadataClearArgs(paneId) {
  return reportMetadataArgs(paneId, METADATA_SOURCE, {}, [ISSUE_TOKEN, INVOCATION_TOKEN]);
}
