// Deliver an issue to the host the user started in the slot they laid out.
//
// Two things this module does not do, and cannot be made to do:
//
//   * It does not type. There is no command construction, no shell quoting and no
//     `pane run` here, because a pane's shell cannot prove it is at a prompt — a shell
//     blocked in its own `read` builtin is the same pid, the same process group and the
//     same name as an idle one. Anything typed into it would be answering somebody's
//     prompt. So delivery talks to a process that asked to be talked to: bin/slot-host.js,
//     started explicitly in the pane, which publishes a socket on that pane's metadata.
//   * It does not change the layout. Nothing here creates, splits, swaps, resizes, moves
//     or closes a pane. When the slot is missing, renamed, duplicated, hostless, busy or
//     unreadable, delivery reports why and leaves the worktree and its layout exactly as
//     herdr made them.
import { realpathSync } from 'node:fs';
import { isAbsolute, basename } from 'node:path';
import { runCmd } from './exec.js';
import { callJson, focusPane, paneGetArgs, paneListArgs, paneProcessInfoArgs, tabListArgs } from './native.js';
import {
  HOST_CHECKOUT_TOKEN, HOST_ID_TOKEN, HOST_PID_TOKEN, HOST_SCRIPT, HOST_SOCKET_TOKEN,
  askHost, buildShowRequest, checkoutDigest, newNonce, validIdentifier,
} from './hostwire.js';

export { HOST_SCRIPT };

// Layout is applied asynchronously after `worktree create|open` returns, so the slot may
// not exist yet on the first look. Every bound here is finite, and every one of them is
// handed to the subprocess that has to respect it: a timer around a synchronous spawn
// cannot interrupt it, so the budget goes in as the child's own timeout.
const DEFAULT_SETTLE_MS = 5000;
const DEFAULT_POLL_MS = 200;
const DEFAULT_COMMAND_MS = 5000;
const MAX_SETTLE_MS = 60000;

// Reject anything that could not be an id: a control character, an empty string.
function typable(value) {
  return typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

// Strip a login shell's leading dash and any directory, so "-zsh" and "/bin/zsh" both
// read as "zsh".
function shellName(value) {
  return basename(String(value || '').replace(/^-/, ''));
}

// A pid herdr reports as absent comes back as null, and a zero or negative one is not a
// process. Both must fail the ownership test rather than pass it by being falsy.
function livePid(value) {
  return Number.isInteger(value) && value > 0;
}

// Is this foreground process an issue host, started the way bin/slot-host.js starts one?
//
// A substring or "argv mentions the script somewhere" test is not identity: any process
// can carry that path in an argument. Require the exact shape — node in argv[0], the host
// script in argv[1], and a --pane naming the pane we are looking at — so an editor opened
// on the file, or a shell running a wrapper, is never mistaken for a host.
function hostIdentity(proc, hostScript) {
  const argv = Array.isArray(proc.argv) ? proc.argv.map(String) : [];
  if (argv.length < 2 || argv[1] !== hostScript) return null;
  const executable = shellName(argv[0]);
  if (executable !== 'node' && executable !== 'node.exe') return null;
  if (proc.name && shellName(proc.name) !== 'node' && shellName(proc.name) !== 'node.exe') return null;
  const paneId = flagValue(argv, '--pane');
  if (!paneId) return null;
  return { paneId };
}

/**
 * What is actually in front of the tty right now.
 *
 * `pane get`'s agent fields describe what herdr believes occupies the pane, which is not
 * the same question: a pane can carry agent metadata while something else runs. Only the
 * foreground process list answers "is the issue host here".
 *
 * There is exactly one accepting answer — the host itself, in the foreground, as its own
 * process-group leader. A shell is not one of them, idle or otherwise: this function
 * cannot tell an idle prompt from a shell blocked in `read`, and it is not asked to.
 */
export function classifyForeground(processInfo, paneId, hostScript = HOST_SCRIPT) {
  if (!processInfo || typeof processInfo !== 'object') {
    return { kind: 'unknown', detail: 'no process information' };
  }
  if (processInfo.pane_id !== paneId) {
    return { kind: 'unknown', detail: `process information is for ${processInfo.pane_id ?? 'another pane'}` };
  }
  const procs = processInfo.foreground_processes;
  // herdr reports an empty list and a null group whenever it could not read the
  // foreground job at all (handle_pane_process_info's unwrap_or_default). That is missing
  // evidence, not evidence of anything.
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
  const identity = hostIdentity(proc, hostScript);
  if (!identity) {
    return { kind: 'busy', detail: `${shellName(proc.name || proc.argv0) || 'a process'} is running, not the issue host` };
  }
  if (identity.paneId !== paneId) {
    return { kind: 'unknown', detail: `the issue host here was started for ${identity.paneId}` };
  }
  // The host has to be what the tty is actually giving input to, which means it is the
  // foreground process group leader. A host suspended behind something else is not in
  // front of anything.
  const group = processInfo.foreground_process_group_id;
  if (!livePid(group)) {
    return { kind: 'unknown', detail: 'no foreground process group reported' };
  }
  if (group !== proc.pid) {
    return { kind: 'busy', detail: 'a job holds the foreground process group' };
  }
  return { kind: 'host', pid: proc.pid, paneId, detail: 'issue host' };
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
  // The checkout the host must be running in has to come from this reply. Falling back to
  // the host's own claim would let a host in an unrelated checkout answer for this one.
  const path = result?.worktree?.path ?? result?.workspace?.worktree?.checkout_path;
  if (typeof path !== 'string' || !path || !isAbsolute(path)) {
    return { ok: false, error: 'herdr worktree reply carried no absolute checkout path' };
  }
  return { ok: true, workspaceId, checkoutPath: path };
}

// Exactly one tab with the configured label, and inside it exactly one pane with the
// configured label. Duplicates are refused rather than guessed at: two panes named
// "Issue / Utility" means the user's layout is not what the config describes, and picking
// one of them would deliver at random.
export function selectSlot(tabs, panes, workspaceId, tabLabel, paneLabel) {
  if (!Array.isArray(tabs)) return { ok: false, error: 'herdr tab list returned no tabs' };
  if (!Array.isArray(panes)) return { ok: false, error: 'herdr pane list returned no panes' };
  // Both queries are workspace-scoped. Discarding malformed or foreign entries could
  // hide a second matching slot and turn uncertain evidence into a delivery target.
  const validId = (value) => typable(value) && value.trim() === value;
  const tabIds = new Set();
  for (const tab of tabs) {
    if (!tab || tab.workspace_id !== workspaceId || !validId(tab.tab_id) || tabIds.has(tab.tab_id)) {
      return { ok: false, error: `invalid tab inventory for ${workspaceId}` };
    }
    tabIds.add(tab.tab_id);
  }
  const paneIds = new Set();
  for (const pane of panes) {
    if (!pane || pane.workspace_id !== workspaceId || !validId(pane.pane_id)
      || !tabIds.has(pane.tab_id) || paneIds.has(pane.pane_id)) {
      return { ok: false, error: `invalid pane inventory for ${workspaceId}` };
    }
    paneIds.add(pane.pane_id);
  }
  const matchedTabs = tabs.filter((t) => t.label === tabLabel);
  if (matchedTabs.length === 0) {
    return { ok: false, error: `no tab labeled ${JSON.stringify(tabLabel)} in ${workspaceId}` };
  }
  if (matchedTabs.length > 1) {
    const ids = matchedTabs.map((t) => t.tab_id).join(', ');
    return { ok: false, error: `${matchedTabs.length} tabs labeled ${JSON.stringify(tabLabel)} in ${workspaceId} (${ids})` };
  }
  const tab = matchedTabs[0];
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
  return { ok: true, tabId: tab.tab_id, paneId: matchedPanes[0].pane_id };
}

function positiveInt(value, fallback, max) {
  return Number.isInteger(value) && value > 0 && value <= max ? value : fallback;
}

// Both labels must be configured explicitly. There is no default slot name: this plugin
// ships to other people's layouts, and a guessed label would deliver into whatever pane a
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
    // Every native call made after the layout has settled gets this as its own bound, so
    // a herdr that accepts a request and never answers cannot hold the picker open.
    commandMs: positiveInt(config.issueSlotCommandMs, DEFAULT_COMMAND_MS, MAX_SETTLE_MS),
  };
}

// One inventory pass: tab list + pane list + the uniqueness rules, both commands bounded
// by whatever is left of the caller's deadline.
function inspect(exec, herdrBin, workspaceId, tabLabel, paneLabel, timeoutMs) {
  const tabs = callJson(exec, herdrBin, tabListArgs(workspaceId), { timeoutMs });
  if (!tabs.ok) return { ok: false, error: tabs.error };
  const panes = callJson(exec, herdrBin, paneListArgs(workspaceId), { timeoutMs });
  if (!panes.ok) return { ok: false, error: panes.error };
  return selectSlot(tabs.result.tabs, panes.result.panes, workspaceId, tabLabel, paneLabel);
}

// Read the pane herdr knows about, and the tokens the host published on it.
function paneState(exec, herdrBin, paneId, timeoutMs) {
  const got = callJson(exec, herdrBin, paneGetArgs(paneId), { timeoutMs });
  if (!got.ok) return { ok: false, error: got.error };
  const pane = got.result.pane;
  if (!pane || pane.pane_id !== paneId) {
    return { ok: false, error: `herdr pane get answered for ${pane?.pane_id ?? 'another pane'}` };
  }
  const tokens = pane.tokens && typeof pane.tokens === 'object' ? pane.tokens : {};
  return { ok: true, tokens, workspaceId: pane.workspace_id, tabId: pane.tab_id, label: pane.label ?? null };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function canonical(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Prove, right now, that this pane holds a live issue host for this checkout.
 *
 * Both halves are required and neither substitutes for the other. The live foreground
 * process says a host exists and what it was started for; the pane's published tokens say
 * where to reach it and which instance it is. Tokens outlive the process that wrote them,
 * so metadata alone never proves aliveness — the pid in the metadata has to be the pid the
 * OS reports in the foreground right now.
 */
function examineHost(exec, herdrBin, target, expected, timeoutMs, hostScript) {
  const { paneId } = target;
  const info = callJson(exec, herdrBin, paneProcessInfoArgs(paneId), { timeoutMs });
  if (!info.ok) return { ok: false, error: info.error };
  const front = classifyForeground(info.result.process_info, paneId, hostScript);
  if (front.kind !== 'host') {
    return { ok: false, error: `slot ${paneId} is not running the issue host: ${front.detail}`, hostless: true };
  }
  const meta = paneState(exec, herdrBin, paneId, timeoutMs);
  if (!meta.ok) return { ok: false, error: meta.error };
  if (meta.workspaceId !== expected.workspaceId || meta.tabId !== target.tabId || meta.label !== expected.paneLabel) {
    return { ok: false, error: `slot ${paneId} no longer matches the configured slot` };
  }
  const tokens = meta.tokens;
  const pid = Number(tokens[HOST_PID_TOKEN]);
  const instance = tokens[HOST_ID_TOKEN];
  const socketPath = tokens[HOST_SOCKET_TOKEN];
  const digest = tokens[HOST_CHECKOUT_TOKEN];
  if (!livePid(pid) || !typable(instance) || !typable(socketPath) || !typable(digest)) {
    return { ok: false, error: `slot ${paneId} carries no complete issue host metadata`, hostless: true };
  }
  if (pid !== front.pid) {
    return { ok: false, error: `slot ${paneId} publishes host ${pid} but is running ${front.pid}` };
  }
  if (!isAbsolute(socketPath)) {
    return { ok: false, error: `slot ${paneId} publishes a relative host socket path` };
  }
  // The host has to be the one for the worktree herdr just opened. Its own checkout is
  // published as a digest; the exact path is compared again over the socket, where the
  // host answers for itself.
  if (digest !== checkoutDigest(expected.checkoutPath)) {
    return { ok: false, error: `slot ${paneId} holds an issue host for another checkout` };
  }
  return { ok: true, pid, instance, socketPath };
}

// Two looks have to describe the same host, or something changed underneath us.
function sameHost(a, b) {
  return a.pid === b.pid && a.instance === b.instance && a.socketPath === b.socketPath;
}

// What to tell the user when the slot is there but nothing is listening in it. The
// command is the real one, with this pane's id in it, because "start the host" without
// saying how is not a diagnostic.
function startHint(paneId, configDir, hostScript) {
  const config = typeof configDir === 'string' && configDir ? ` --config-dir ${configDir}` : '';
  return `start it there with: node ${hostScript} --pane ${paneId}${config}`;
}

/**
 * Show `identifier` in the issue host running in the configured slot of the workspace the
 * worktree reply names.
 *
 * Returns { ok: true, action: 'accepted' | 'focused', paneId } or { ok: false, error }.
 * Every failure path is a report, never a repair, and never an input: nothing in here
 * opens, moves, closes or writes to a pane.
 */
export async function deliverIssueDetails({
  worktreeStdout,
  identifier,
  config = {},
  configDir,
  socketPath,
  exec = runCmd,
  herdrBin = 'herdr',
  hostScript = HOST_SCRIPT,
  sleep = wait,
  now = Date.now,
  nonce = newNonce,
  focus = focusPane,
  ask = askHost,
} = {}) {
  const settings = slotSettings(config);
  if (!settings.ok) return { ok: false, error: settings.error };
  if (!validIdentifier(identifier)) return { ok: false, error: `${JSON.stringify(identifier)} is not a Linear issue identifier` };

  const workspace = readWorktreeWorkspace(worktreeStdout);
  if (!workspace.ok) return { ok: false, error: workspace.error };
  const { workspaceId } = workspace;
  // Both sides have to mean the same directory rather than two spellings of it: on macOS
  // a worktree under /tmp or /var is reached through a symlinked ancestor, and the host
  // resolves its own checkout the same way. A path that cannot be resolved is compared as
  // it came, which simply fails to match — never matches something else.
  const checkoutPath = canonical(workspace.checkoutPath);
  const expected = { workspaceId, checkoutPath, paneLabel: settings.paneLabel };

  // Wait out the asynchronous layout, but only for the configured deadline, and hand each
  // subprocess what is left of it. A failed or malformed inventory is retried too —
  // layout application is exactly when a tab can be half-built — and whatever the last
  // look said becomes the diagnostic if time runs out.
  const deadline = now() + settings.settleMs;
  let found = { ok: false, error: `the layout for ${workspaceId} did not settle within ${settings.settleMs}ms` };
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    found = inspect(exec, herdrBin, workspaceId, settings.tabLabel, settings.paneLabel, remaining);
    if (found.ok) break;
    const left = deadline - now();
    if (left <= 0) break;
    await sleep(Math.min(settings.pollMs, left));
  }
  if (!found.ok) return { ok: false, error: found.error };
  const target = { paneId: found.paneId, tabId: found.tabId };
  const { paneId } = target;

  const ms = settings.commandMs;
  const hostless = (result) => (result.hostless
    ? { ok: false, error: `${result.error} — ${startHint(paneId, configDir, hostScript)}` }
    : { ok: false, error: result.error });

  const first = examineHost(exec, herdrBin, target, expected, ms, hostScript);
  if (!first.ok) return hostless(first);

  // Everything above was read before the request existed. Look again: the slot may have
  // been renamed or closed, and the host may have exited and been replaced, in the
  // meantime. The window between this check and the request cannot be closed from here —
  // it is narrowed, and the host itself refuses a request that names the wrong instance.
  const again = inspect(exec, herdrBin, workspaceId, settings.tabLabel, settings.paneLabel, ms);
  if (!again.ok) return { ok: false, error: again.error };
  if (again.paneId !== paneId || again.tabId !== target.tabId) {
    return { ok: false, error: `slot moved from ${paneId} to ${again.paneId} while preparing` };
  }
  const second = examineHost(exec, herdrBin, target, expected, ms, hostScript);
  if (!second.ok) return hostless(second);
  if (!sameHost(first, second)) return { ok: false, error: `slot ${paneId} changed issue host while preparing` };

  const request = buildShowRequest({
    issue: identifier,
    pane: paneId,
    host: second.instance,
    pid: second.pid,
    checkout: checkoutPath,
    id: nonce(),
  });
  const answered = await ask(second.socketPath, request, {
    id: request.id, pane: paneId, host: second.instance, pid: second.pid, checkout: checkoutPath, issue: identifier,
  }, { timeoutMs: ms });
  if (!answered.ok) return { ok: false, error: `slot ${paneId}: ${answered.error}` };

  // A fresh host took the issue and is fetching it. It renders in its own pane; the user
  // is already being moved to this workspace by herdr, so nothing is focused here and
  // nothing claims the fetch has succeeded.
  if (answered.status === 'accepted') {
    return { ok: true, action: 'accepted', paneId, issue: identifier, host: second.instance };
  }

  // The host already has this issue. Focusing moves the user, so it gets one more fresh
  // ownership check first: the confirmation came from the host, and this says the host is
  // still the thing in front of that pane.
  const live = examineHost(exec, herdrBin, target, expected, ms, hostScript);
  if (!live.ok) return hostless(live);
  if (!sameHost(second, live)) return { ok: false, error: `slot ${paneId} changed issue host while preparing` };
  const focused = await focus(paneId, { socketPath, timeoutMs: ms });
  if (!focused.ok) return { ok: false, error: focused.error };
  return { ok: true, action: 'focused', paneId, issue: identifier, host: live.instance };
}
