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
import { basename, isAbsolute } from 'node:path';
import { runCmd } from './exec.js';
import {
  callJson, callVoid, focusPane, paneGetArgs, paneListArgs, paneProcessInfoArgs,
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

// `env -u NAME cmd` rather than a `NAME= cmd` assignment prefix: the slot's shell may be
// fish or csh, where a leading assignment is not a command prefix at all. /usr/bin/env is
// the one path POSIX systems agree on, and -u is supported by both BSD and GNU env.
const ENV_PREFIX = ['/usr/bin/env', '-u', 'NODE_OPTIONS'];

/**
 * The exact command line the slot's shell runs.
 *
 * Every path is absolute and required. A relative or missing one would let the shell's own
 * cwd decide which repository the viewer routes against, and the shell's PATH decide which
 * node runs. NODE_OPTIONS is cleared for the child because it is inherited otherwise, and
 * it can inject `--import`/`--require` into the viewer before a line of it runs. The rest
 * of the environment is deliberately preserved: the provider variables holding the Linear
 * keys live there, and no key value ever reaches this argument list.
 *
 * --issue and --invocation are the observable identity a later delivery reads back out of
 * the live process's argv; --pane is the pane the viewer publishes that identity on.
 */
export function buildViewerCommand(spec) {
  const { nodePath, scriptPath, identifier, invocation, configDir, cwd, paneId } = spec;
  const required = { node: nodePath, script: scriptPath, 'config directory': configDir, checkout: cwd };
  for (const [name, value] of Object.entries(required)) {
    if (typeof value !== 'string' || !value || !isAbsolute(value)) {
      return { ok: false, error: `issue viewer needs an absolute ${name} path` };
    }
  }
  const parts = [
    ...ENV_PREFIX, nodePath, scriptPath,
    '--issue', identifier, '--invocation', invocation,
    '--config-dir', configDir, '--cwd', cwd, '--pane', paneId,
  ];
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
function shellName(value) {
  return basename(String(value || '').replace(/^-/, ''));
}

// A pid herdr reports as absent comes back as null, and a zero or negative one is not a
// process. Both must fail the ownership test rather than pass it by being falsy.
function livePid(value) {
  return Number.isInteger(value) && value > 0;
}

// Is this foreground process our viewer, started the way lib/slot.js starts one?
//
// A substring or "argv mentions the script somewhere" test is not identity: any process
// can carry that path in an argument. Require the exact shape this module builds — node
// in argv[0], the script in argv[1], and all three flags present with values — so an
// editor opened on the file, or a shell running a wrapper, is never mistaken for a viewer.
// `env -u NODE_OPTIONS` execs node in place, so the prefix does not appear in argv.
function viewerIdentity(proc, scriptPath) {
  const argv = Array.isArray(proc.argv) ? proc.argv.map(String) : [];
  if (argv.length < 2 || argv[1] !== scriptPath) return null;
  const executable = shellName(argv[0]);
  if (executable !== 'node' && executable !== 'node.exe') return null;
  if (proc.name && shellName(proc.name) !== 'node' && shellName(proc.name) !== 'node.exe') return null;
  const issue = flagValue(argv, '--issue');
  const invocation = flagValue(argv, '--invocation');
  const paneId = flagValue(argv, '--pane');
  if (!issue || !invocation || !paneId) return null;
  return { issue, invocation, paneId };
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
  // herdr reports an empty list and a null group whenever it could not read the
  // foreground job at all (handle_pane_process_info's unwrap_or_default). That is missing
  // evidence, not evidence of an idle shell.
  if (!Array.isArray(procs) || procs.length === 0) {
    return { kind: 'unknown', detail: 'no foreground process reported' };
  }
  if (procs.length > 1) {
    return { kind: 'busy', detail: `${procs.length} foreground processes` };
  }
  const proc = procs[0];
  if (!proc || typeof proc !== 'object' || !livePid(proc.pid)) {
    return { kind: 'unknown', detail: 'malformed foreground process' };
  }
  // Our own viewer first: it runs as node, so its pid is never the shell's.
  const viewer = viewerIdentity(proc, scriptPath);
  if (viewer) return { kind: 'viewer', ...viewer, detail: 'issue viewer' };

  // "The shell is in the foreground" means the foreground process IS the shell process,
  // not merely a process that shares its name. All three have to hold, and each has to be
  // a real pid: an absent shell_pid or an absent process group is missing evidence, and
  // missing evidence is never ownership.
  const shellPid = processInfo.shell_pid;
  if (!livePid(shellPid)) {
    return { kind: 'unknown', detail: 'no shell process id reported' };
  }
  if (proc.pid !== shellPid) {
    return { kind: 'busy', detail: `${proc.name || 'a process'} is running` };
  }
  const group = processInfo.foreground_process_group_id;
  if (!livePid(group)) {
    return { kind: 'unknown', detail: 'no foreground process group reported' };
  }
  if (group !== shellPid) {
    return { kind: 'busy', detail: 'a job holds the foreground process group' };
  }
  const name = shellName(proc.name || proc.argv0);
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
  // The checkout the viewer runs in has to come from this reply. Falling back to the
  // shell's own cwd would let a malformed or truncated reply route the viewer against
  // whatever repository that pane happened to be sitting in.
  const path = result?.worktree?.path ?? result?.workspace?.worktree?.checkout_path;
  if (typeof path !== 'string' || !path || !isAbsolute(path)) {
    return { ok: false, error: 'herdr worktree reply carried no absolute checkout path' };
  }
  return { ok: true, workspaceId, checkoutPath: path };
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

// Does the viewer in front of this pane agree, with itself and with us, that it is
// showing this issue? Both halves are required: the live argv proves a process exists
// and what it was started with, the pane's tokens prove that process published the same
// identity. Tokens outlive the process that wrote them, so they can only ever confirm a
// live argv, never stand in for one.
function viewerAgrees(exec, herdrBin, paneId, identifier, state, expected) {
  const meta = paneTokens(exec, herdrBin, paneId);
  if (!meta.ok) return { ok: false, error: meta.error };
  if (meta.workspaceId !== expected.workspaceId || meta.tabId !== expected.tabId || meta.label !== expected.paneLabel) {
    return { ok: false, error: `slot ${paneId} no longer matches the configured slot` };
  }
  const agrees = state.issue === identifier
    && typeof state.invocation === 'string' && state.invocation !== ''
    && state.paneId === paneId
    && meta.tokens[ISSUE_TOKEN] === identifier
    && meta.tokens[INVOCATION_TOKEN] === state.invocation;
  if (!agrees) {
    const other = state.issue && state.issue !== identifier ? ` for ${state.issue}` : '';
    return { ok: false, error: `slot ${paneId} holds another issue viewer${other}` };
  }
  return { ok: true };
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
  socketPath,
  exec = runCmd,
  herdrBin = 'herdr',
  nodePath = process.execPath,
  scriptPath = VIEWER_SCRIPT,
  sleep = wait,
  now = Date.now,
  invocation = newInvocation,
  focus = focusPane,
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
    const agreed = viewerAgrees(exec, herdrBin, paneId, identifier, state, {
      workspaceId, tabId, paneLabel: settings.paneLabel,
    });
    if (!agreed.ok) return agreed;
    // Focusing moves the user, so it gets the same treatment as typing: look again, and
    // require the slot and the process still to be what they were a moment ago.
    const stillThere = inspect(exec, herdrBin, workspaceId, settings.tabLabel, settings.paneLabel);
    if (!stillThere.ok) return { ok: false, error: stillThere.error };
    if (stillThere.paneId !== paneId || stillThere.tabId !== tabId) {
      return { ok: false, error: `slot moved from ${paneId} to ${stillThere.paneId} while preparing` };
    }
    const recheck = callJson(exec, herdrBin, paneProcessInfoArgs(paneId));
    if (!recheck.ok) return { ok: false, error: recheck.error };
    const live = classifyForeground(recheck.result.process_info, paneId, scriptPath);
    if (live.kind !== 'viewer') {
      return { ok: false, error: `slot ${paneId} stopped holding its issue viewer: ${live.detail}` };
    }
    const stillAgreed = viewerAgrees(exec, herdrBin, paneId, identifier, live, {
      workspaceId, tabId, paneLabel: settings.paneLabel,
    });
    if (!stillAgreed.ok) return stillAgreed;
    if (live.invocation !== state.invocation) {
      return { ok: false, error: `slot ${paneId} changed viewer while preparing` };
    }
    const focused = await focus(paneId, { socketPath });
    if (!focused.ok) return { ok: false, error: focused.error };
    return { ok: true, action: 'focused', paneId, issue: identifier, invocation: live.invocation };
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
    configDir,
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
