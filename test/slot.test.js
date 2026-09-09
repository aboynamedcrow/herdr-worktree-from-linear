import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyForeground, deliverIssueDetails, readWorktreeWorkspace, selectSlot, slotSettings,
} from '../lib/slot.js';
import { HOST_SCRIPT, checkoutDigest } from '../lib/hostwire.js';

const WS = 'w9';
const TAB = 'w9:t1';
const SLOT = 'w9:p2';
const CHECKOUT = '/wt/bit-1';
const CONFIG = {
  issueTabLabel: 'Crew', issuePaneLabel: 'Issue / Utility',
  issueSlotSettleMs: 1000, issueSlotPollMs: 200, issueSlotCommandMs: 400,
};

// Reply shapes copied from herdr 0.9.0 captures: `result` wraps a typed payload, and the
// CLI prints it as JSON with no --json flag.
const tabsReply = (tabs) => JSON.stringify({ id: 'cli:tab:list', result: { type: 'tab_list', tabs } });
const panesReply = (panes) => JSON.stringify({ id: 'cli:pane:list', result: { type: 'pane_list', panes } });
const processReply = (info) => JSON.stringify({ id: 'cli:pane:process_info', result: { type: 'pane_process_info', process_info: info } });
const paneReply = (p) => JSON.stringify({ id: 'cli:pane:get', result: { type: 'pane_info', pane: p } });

const tab = (over = {}) => ({ tab_id: TAB, workspace_id: WS, number: 1, label: 'Crew', focused: true, pane_count: 4, agent_status: 'unknown', ...over });
const pane = (over = {}) => ({ pane_id: SLOT, tab_id: TAB, workspace_id: WS, terminal_id: 't', focused: false, agent_status: 'unknown', revision: 0, label: 'Issue / Utility', ...over });

// The tokens a live host publishes on its own pane.
const HOST_PID = 30001;
const HOST_ID = 'instance-token-0';
const HOST_SOCK = '/tmp/wfl-host-abc/def.sock';
const hostTokens = (over = {}) => ({
  'wfl-host-pid': String(HOST_PID),
  'wfl-host-id': HOST_ID,
  'wfl-host-sock': HOST_SOCK,
  'wfl-host-cwd': checkoutDigest(CHECKOUT),
  ...over,
});

// What herdr reports for a pane whose foreground process is the issue host.
const hostArgv = (paneId = SLOT) => [process.execPath, HOST_SCRIPT, '--pane', paneId, '--config-dir', '/cfg', '--cwd', CHECKOUT];
const hostFront = (over = {}, procOver = {}) => ({
  pane_id: SLOT,
  shell_pid: 22278,
  foreground_process_group_id: HOST_PID,
  foreground_processes: [{ pid: HOST_PID, name: 'node', argv0: 'node', argv: hostArgv(), cwd: CHECKOUT, ...procOver }],
  ...over,
});

// An idle-looking login shell. This is the shape that used to be treated as "safe to type
// into" — and the shape a shell blocked in its own `read` builtin has too.
const idleShell = (over = {}) => ({
  pane_id: SLOT,
  shell_pid: 22278,
  foreground_process_group_id: 22278,
  foreground_processes: [{ pid: 22278, name: 'zsh', argv0: 'zsh', argv: ['-zsh'], cwd: CHECKOUT }],
  ...over,
});

// A shell that is not at a prompt at all: it is sitting in `read` inside a script. From
// the outside it is indistinguishable from the one above — same pid, same group, same
// name — which is exactly why neither of them is ever delivered into.
const readingShell = () => ({
  pane_id: SLOT,
  shell_pid: 87005,
  foreground_process_group_id: 87005,
  foreground_processes: [{ pid: 87005, name: 'bash', argv0: 'bash', argv: ['bash', '--norc', '-c', 'read -r answer'], cwd: CHECKOUT }],
});

const worktreeStdout = (over = {}) => JSON.stringify({
  id: 'cli:worktree:create',
  result: {
    type: 'worktree_created',
    workspace: { workspace_id: WS, number: 8, label: 'BIT-1', focused: true, pane_count: 4, tab_count: 1, active_tab_id: TAB, agent_status: 'unknown' },
    tab: tab(),
    root_pane: pane({ pane_id: 'w9:p1', label: 'Orchestrator' }),
    worktree: { path: CHECKOUT, label: 'bit-1', is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true },
    ...over,
  },
});

// Dispatches on the first two CLI words ("pane list", "pane process-info", ...). A handler
// is a JSON string, a { status, stdout, stderr } triple, or a function of the call index.
// Every call's options are kept too: the deadline a caller owns is only real if it reaches
// the subprocess.
function fakeHerdr(handlers) {
  const calls = [];
  const options = [];
  const seen = new Map();
  const exec = (cmd, args = [], opts = {}) => {
    calls.push([cmd, ...args]);
    options.push(opts);
    const key = `${args[0]} ${args[1]}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    const handler = handlers[key];
    if (handler === undefined) return { status: 1, stdout: '', stderr: `unexpected ${key}` };
    const out = typeof handler === 'function' ? handler(nth, args) : handler;
    if (typeof out === 'string') return { status: 0, stdout: out, stderr: '' };
    return { status: out.status ?? 0, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
  };
  return { exec, calls, options };
}

// A clock that steps by one poll each read, so the settle deadline is reached without any
// real waiting.
function clock(step = 200) {
  let t = 0;
  return () => { const v = t; t += step; return v; };
}

let focused = [];
let asked = [];

const deliver = (over = {}) => deliverIssueDetails({
  worktreeStdout: worktreeStdout(),
  identifier: 'BIT-1',
  config: CONFIG,
  configDir: '/cfg',
  socketPath: '/tmp/herdr-fake.sock',
  herdrBin: 'herdr',
  sleep: async () => {},
  now: clock(),
  nonce: () => 'nonce0',
  focus: async (paneId) => { focused.push(paneId); return { ok: true, pane: { pane_id: paneId } }; },
  // The real client is exercised against a real socket in test/host.test.js and against a
  // real host process in test/slot-host.test.js; here it is injected so the driver's own
  // decisions are what is under test.
  ask: async (socketPath, request, expected) => {
    asked.push({ socketPath, request, expected });
    return { ok: true, status: 'accepted', issue: request.issue, detail: 'starting' };
  },
  ...over,
});

const happy = () => ({
  'tab list': tabsReply([tab()]),
  'pane list': panesReply([pane({ pane_id: 'w9:p1', label: 'Orchestrator' }), pane()]),
  'pane process-info': processReply(hostFront()),
  'pane get': paneReply(pane({ tokens: hostTokens() })),
});

// Layout is created out of band, so anything that opens, moves, resizes or closes a pane
// would be this plugin rearranging a layout it did not build — and anything that writes to
// a terminal would be it typing into a shell it cannot read.
const FORBIDDEN = ['split', 'swap', 'move', 'resize', 'close', 'zoom', 'open', 'run', 'send-input', 'send-keys', 'paste'];
function assertReadOnly(calls) {
  for (const call of calls) {
    for (const verb of FORBIDDEN) {
      assert.equal(call.includes(verb), false, `must not run: ${call.join(' ')}`);
    }
  }
}

test.beforeEach(() => { focused = []; asked = []; });

// ---------------------------------------------------------------------------
// Configuration and replies

test('slotSettings requires both labels and never invents one', () => {
  assert.match(slotSettings({}).error, /issueTabLabel and issuePaneLabel/);
  assert.match(slotSettings({ issueTabLabel: 'Crew' }).error, /issuePaneLabel/);
  const s = slotSettings({ issueTabLabel: 'Crew', issuePaneLabel: 'Issue' });
  assert.equal(s.ok, true);
  assert.equal(s.settleMs, 5000);
  assert.equal(s.pollMs, 200);
  assert.equal(s.commandMs, 5000);
  // Out-of-range values fall back rather than removing the bound, and a poll never
  // outlasts the deadline it is polling towards.
  assert.equal(slotSettings({ issueTabLabel: 'a', issuePaneLabel: 'b', issueSlotSettleMs: -1 }).settleMs, 5000);
  assert.equal(slotSettings({ issueTabLabel: 'a', issuePaneLabel: 'b', issueSlotCommandMs: 999999 }).commandMs, 5000);
  assert.equal(slotSettings({ issueTabLabel: 'a', issuePaneLabel: 'b', issueSlotSettleMs: 50 }).pollMs, 50);
});

test('readWorktreeWorkspace takes the workspace from the reply, and rejects an incoherent one', () => {
  const good = readWorktreeWorkspace(worktreeStdout());
  assert.deepEqual(good, { ok: true, workspaceId: WS, checkoutPath: CHECKOUT });
  assert.match(readWorktreeWorkspace('not json').error, /unparseable/);
  assert.match(readWorktreeWorkspace('{"result":{}}').error, /no workspace id/);
  const foreignTab = worktreeStdout({ tab: tab({ workspace_id: 'w8' }) });
  assert.match(readWorktreeWorkspace(foreignTab).error, /tab belongs to w8/);
  const foreignPane = worktreeStdout({ root_pane: pane({ workspace_id: 'w8' }) });
  assert.match(readWorktreeWorkspace(foreignPane).error, /root pane belongs to w8/);
});

test('readWorktreeWorkspace demands an absolute checkout path from the reply', () => {
  assert.match(readWorktreeWorkspace(worktreeStdout({ worktree: { path: 'wt/bit-1' } })).error, /absolute checkout/);
  assert.match(readWorktreeWorkspace(worktreeStdout({ worktree: {} })).error, /absolute checkout/);
  // The older reply shape carries it under the workspace instead.
  const nested = JSON.stringify({ result: {
    workspace: { workspace_id: WS, worktree: { checkout_path: CHECKOUT } },
  } });
  assert.equal(readWorktreeWorkspace(nested).checkoutPath, CHECKOUT);
});

test('selectSlot demands exactly one labeled tab and one labeled pane inside it', () => {
  const panes = [pane()];
  assert.deepEqual(selectSlot([tab()], panes, WS, 'Crew', 'Issue / Utility'), { ok: true, tabId: TAB, paneId: SLOT });
  assert.match(selectSlot([tab({ label: 'Other' })], panes, WS, 'Crew', 'Issue / Utility').error, /no tab labeled/);
  const twoTabs = [tab(), tab({ tab_id: 'w9:t2' })];
  assert.match(selectSlot(twoTabs, panes, WS, 'Crew', 'Issue / Utility').error, /2 tabs labeled/);
  const twoPanes = [pane(), pane({ pane_id: 'w9:p3' })];
  assert.match(selectSlot([tab()], twoPanes, WS, 'Crew', 'Issue / Utility').error, /2 panes labeled/);
  assert.match(selectSlot([tab()], [pane({ label: 'Other' })], WS, 'Crew', 'Issue / Utility').error, /no pane labeled/);
  // A pane in another workspace, or in a tab this workspace does not have, is a reply we
  // cannot reason about — not something to filter out quietly.
  assert.match(selectSlot([tab()], [pane({ workspace_id: 'w8' })], WS, 'Crew', 'Issue / Utility').error, /invalid pane inventory/);
  assert.match(selectSlot([tab()], [pane({ tab_id: 'w9:t9' })], WS, 'Crew', 'Issue / Utility').error, /invalid pane inventory/);
  assert.match(selectSlot(null, panes, WS, 'Crew', 'Issue / Utility').error, /no tabs/);
});

test('delivery refuses incomplete or conflicting scoped inventories before touching the slot', async () => {
  for (const [label, panes] of [
    ['a duplicate pane id', [pane(), pane()]],
    ['a pane with no id', [pane({ pane_id: '' })]],
    ['a pane whose id is padded', [pane({ pane_id: ' w9:p2 ' })]],
  ]) {
    const { exec, calls } = fakeHerdr({ ...happy(), 'pane list': panesReply(panes) });
    const res = await deliver({ exec });
    assert.equal(res.ok, false, label);
    assert.match(res.error, /invalid pane inventory/);
    assert.equal(calls.some((c) => c[2] === 'process-info'), false, 'no process was even inspected');
    assertReadOnly(calls);
  }
});

// ---------------------------------------------------------------------------
// What is in front of the pane

test('classifyForeground recognizes the issue host, and nothing else', () => {
  const host = classifyForeground(hostFront(), SLOT);
  assert.equal(host.kind, 'host');
  assert.equal(host.pid, HOST_PID);
  // Every rejection below is a refusal to deliver, not a fallback to something weaker.
  assert.equal(classifyForeground(hostFront({}, { argv: [process.execPath, '/elsewhere/slot-host.js', '--pane', SLOT] }), SLOT).kind, 'busy');
  assert.equal(classifyForeground(hostFront({}, { argv: [process.execPath, HOST_SCRIPT] }), SLOT).kind, 'busy');
  assert.equal(classifyForeground(hostFront({}, { argv: ['vim', HOST_SCRIPT, '--pane', SLOT] }), SLOT).kind, 'busy');
  assert.equal(classifyForeground(hostFront({}, { name: 'vim' }), SLOT).kind, 'busy');
  // A host started for another pane is publishing somewhere else; it is not this slot's.
  const strayPane = classifyForeground(hostFront({}, { argv: hostArgv('w9:p7') }), SLOT);
  assert.equal(strayPane.kind, 'unknown');
  assert.match(strayPane.detail, /started for w9:p7/);
  // The host has to be what the tty is giving input to.
  assert.equal(classifyForeground(hostFront({ foreground_process_group_id: 999 }), SLOT).kind, 'busy');
});

test('no shell is ever an acceptable slot, idle-looking or not', () => {
  // The P1 shape: a shell alone in the foreground, its own process group leader. An idle
  // prompt and a shell blocked in `read` are the same observation, so both are refused.
  for (const info of [idleShell(), readingShell()]) {
    const state = classifyForeground(info, SLOT);
    assert.equal(state.kind, 'busy');
    assert.match(state.detail, /is running, not the issue host/);
  }
});

test('classifyForeground treats absent or impossible evidence as unknown', () => {
  assert.equal(classifyForeground(null, SLOT).kind, 'unknown');
  assert.equal(classifyForeground({ pane_id: 'w9:p3' }, SLOT).kind, 'unknown');
  assert.match(classifyForeground({ pane_id: SLOT, foreground_processes: [] }, SLOT).detail, /no foreground process/);
  assert.equal(classifyForeground(hostFront({}, { pid: 0 }), SLOT).kind, 'unknown');
  assert.equal(classifyForeground(hostFront({}, { pid: null }), SLOT).kind, 'unknown');
  assert.equal(classifyForeground(hostFront({ foreground_process_group_id: null }), SLOT).kind, 'unknown');
  // More than one process in the foreground is a job, whatever the names are.
  const two = { ...hostFront(), foreground_processes: [...hostFront().foreground_processes, { pid: 5, name: 'node', argv: hostArgv() }] };
  assert.equal(classifyForeground(two, SLOT).kind, 'busy');
});

// ---------------------------------------------------------------------------
// Delivery

test('delivery hands the issue to the live host and types nothing anywhere', async () => {
  const { exec, calls } = fakeHerdr(happy());
  const res = await deliver({ exec });
  assert.deepEqual(res, { ok: true, action: 'accepted', paneId: SLOT, issue: 'BIT-1', host: HOST_ID });
  assert.equal(asked.length, 1);
  // The request names the host it was addressed to, and carries an issue — never a
  // command, a script or an environment.
  assert.deepEqual(asked[0].request, {
    protocol: 'wfl-host-1', id: 'nonce0', op: 'show', issue: 'BIT-1',
    pane: SLOT, host: HOST_ID, pid: HOST_PID, checkout: CHECKOUT,
  });
  assert.equal(asked[0].socketPath, HOST_SOCK);
  assert.deepEqual(focused, [], 'a fresh delivery does not move the user');
  assertReadOnly(calls);
  // Every native call is workspace- or pane-scoped, and none of them asks about "current".
  for (const c of calls.filter((x) => x[2] === 'list')) assert.ok(c.includes(WS));
  assert.equal(calls.some((c) => c.includes('--current')), false);
});

test('a repeat delivery focuses the host that already holds this issue', async () => {
  const { exec, calls } = fakeHerdr(happy());
  const res = await deliver({
    exec,
    ask: async (socketPath, request) => {
      asked.push({ socketPath, request });
      return { ok: true, status: 'showing', issue: request.issue, detail: 'showing' };
    },
  });
  assert.deepEqual(res, { ok: true, action: 'focused', paneId: SLOT, issue: 'BIT-1', host: HOST_ID });
  assert.deepEqual(focused, [SLOT]);
  assertReadOnly(calls);
  // Focus moves the user, so ownership is proved again after the host confirms: three
  // process-info reads, three metadata reads, and only then a focus.
  assert.equal(calls.filter((c) => c[2] === 'process-info').length, 3);
  assert.equal(calls.filter((c) => c[2] === 'get').length, 3);
});

test('a host that has gone between the confirmation and the focus is not focused', async () => {
  const { exec, calls } = fakeHerdr({
    ...happy(),
    // The third look — the one taken immediately before focusing — finds a shell.
    'pane process-info': (nth) => processReply(nth < 2 ? hostFront() : idleShell()),
  });
  const res = await deliver({
    exec,
    ask: async () => ({ ok: true, status: 'showing', issue: 'BIT-1', detail: 'showing' }),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /not running the issue host/);
  assert.deepEqual(focused, [], 'nothing moved the user');
  assertReadOnly(calls);
});

test('a busy host is reported, and nothing is retried into it', async () => {
  const { exec, calls } = fakeHerdr(happy());
  const res = await deliver({
    exec,
    ask: async () => ({ ok: false, error: 'issue host is busy: showing BIT-9' }),
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /busy: showing BIT-9/);
  assert.deepEqual(focused, []);
  assertReadOnly(calls);
});

test('a slot with no host says so, and says how to start one', async () => {
  for (const info of [idleShell(), readingShell(), { pane_id: SLOT, foreground_processes: [] }]) {
    const { exec, calls } = fakeHerdr({ ...happy(), 'pane process-info': processReply(info) });
    const res = await deliver({ exec });
    assert.equal(res.ok, false);
    assert.match(res.error, /is not running the issue host/);
    // The fallback is explicit: this is the command, for this pane, with this config.
    assert.match(res.error, new RegExp(`start it there with: node ${HOST_SCRIPT.replace(/[/.]/g, '\\$&')} --pane ${SLOT} --config-dir /cfg`));
    assert.equal(asked.length, 0, 'nothing was sent anywhere');
    assertReadOnly(calls);
  }
});

test('metadata left behind by an exited host never counts as a live one', async () => {
  // Tokens from a host that is gone, in front of a pane that is back at its shell.
  const { exec } = fakeHerdr({ ...happy(), 'pane process-info': processReply(idleShell()) });
  const stale = await deliver({ exec });
  assert.equal(stale.ok, false);
  assert.equal(asked.length, 0);

  // A live host whose published pid is not the pid actually in the foreground: the tokens
  // are somebody else's, so they prove nothing about this process.
  const mismatched = fakeHerdr({ ...happy(), 'pane get': paneReply(pane({ tokens: hostTokens({ 'wfl-host-pid': '999' }) })) });
  const res = await deliver({ exec: mismatched.exec });
  assert.equal(res.ok, false);
  assert.match(res.error, /publishes host 999 but is running 30001/);
  assert.equal(asked.length, 0);
});

test('incomplete or unusable host metadata refuses rather than guesses', async () => {
  for (const [label, tokens] of [
    ['no tokens at all', {}],
    ['no socket', hostTokens({ 'wfl-host-sock': undefined })],
    ['no instance', hostTokens({ 'wfl-host-id': '' })],
    ['a relative socket path', hostTokens({ 'wfl-host-sock': 'relative.sock' })],
    ['a pid that is not one', hostTokens({ 'wfl-host-pid': 'many' })],
  ]) {
    const { exec } = fakeHerdr({ ...happy(), 'pane get': paneReply(pane({ tokens })) });
    const res = await deliver({ exec });
    assert.equal(res.ok, false, label);
    assert.equal(asked.length, 0, label);
  }
});

test('a host running in another checkout is not this worktree host', async () => {
  const { exec } = fakeHerdr({
    ...happy(),
    'pane get': paneReply(pane({ tokens: hostTokens({ 'wfl-host-cwd': checkoutDigest('/wt/other') }) })),
  });
  const res = await deliver({ exec });
  assert.equal(res.ok, false);
  assert.match(res.error, /another checkout/);
  assert.equal(asked.length, 0);
});

test('the pane the host publishes on has to still be the configured slot', async () => {
  for (const over of [{ label: 'Renamed' }, { tab_id: 'w9:t9' }, { workspace_id: 'w8' }]) {
    const { exec } = fakeHerdr({ ...happy(), 'pane get': paneReply(pane({ tokens: hostTokens(), ...over })) });
    const res = await deliver({ exec });
    assert.equal(res.ok, false);
    assert.match(res.error, /no longer matches the configured slot/);
    assert.equal(asked.length, 0);
  }
});

test('a host replaced between the two looks stops the request', async () => {
  const { exec } = fakeHerdr({
    ...happy(),
    // Same pane, same label, different instance: the host quit and another one started.
    'pane get': (nth) => paneReply(pane({ tokens: hostTokens(nth === 0 ? {} : { 'wfl-host-id': 'instance-token-1' }) })),
  });
  const res = await deliver({ exec });
  assert.equal(res.ok, false);
  assert.match(res.error, /changed issue host while preparing/);
  assert.equal(asked.length, 0);
});

test('a slot that moves between the two looks stops the request', async () => {
  const { exec } = fakeHerdr({
    ...happy(),
    'pane list': (nth) => panesReply([pane({ pane_id: nth === 0 ? SLOT : 'w9:p5' })]),
  });
  const res = await deliver({ exec });
  assert.equal(res.ok, false);
  assert.match(res.error, /slot moved from w9:p2 to w9:p5/);
  assert.equal(asked.length, 0);
});

// ---------------------------------------------------------------------------
// Bounds

test('delivery waits out a layout that has not been applied yet', async () => {
  const slept = [];
  const { exec } = fakeHerdr({
    ...happy(),
    // The Crew tab appears on the third look, the way an asynchronous layout arrives.
    'tab list': (nth) => tabsReply(nth < 2 ? [] : [tab()]),
    'pane list': (nth) => panesReply(nth < 2 ? [] : [pane()]),
  });
  const res = await deliver({ exec, now: clock(100), sleep: async (ms) => slept.push(ms) });
  assert.equal(res.ok, true, res.error);
  assert.equal(slept.length, 2);
  // Each wait is capped by the poll interval and by whatever is left of the deadline.
  for (const ms of slept) assert.ok(ms <= 200 && ms > 0, `slept ${ms}`);
});

test('delivery gives up on a finite deadline and reports what it last saw', async () => {
  const slept = [];
  // A workspace whose layout never arrives: no tabs, and so no panes either.
  const { exec, calls } = fakeHerdr({ ...happy(), 'tab list': tabsReply([]), 'pane list': panesReply([]) });
  const res = await deliver({ exec, now: clock(300), sleep: async (ms) => slept.push(ms) });
  assert.equal(res.ok, false);
  assert.match(res.error, /no tab labeled "Crew"/);
  // 1000ms of budget in 300ms steps: it stops, and it stops without waiting past the end.
  assert.ok(calls.length <= 8, `gave up after ${calls.length} calls`);
  for (const ms of slept) assert.ok(ms > 0 && ms <= 200);
  assertReadOnly(calls);
});

test('every native call carries the deadline its caller owns', async () => {
  const { exec, calls, options } = fakeHerdr(happy());
  const res = await deliver({ exec });
  assert.equal(res.ok, true, res.error);
  assert.equal(calls.length, options.length);
  for (const [i, opts] of options.entries()) {
    assert.equal(typeof opts.timeout, 'number', `${calls[i].join(' ')} was spawned with no timeout`);
    assert.ok(opts.timeout > 0 && opts.timeout <= 1000, `${calls[i].join(' ')} timeout ${opts.timeout}`);
  }
  // The settle loop's commands are bounded by what is left of the settle budget; the
  // checks after it by the per-command budget.
  const settle = options.slice(0, 2).map((o) => o.timeout);
  for (const ms of settle) assert.ok(ms <= 1000);
  for (const opts of options.slice(2)) assert.equal(opts.timeout, 400);
});

test('a settle deadline that is already spent spawns nothing at all', async () => {
  const { exec, calls } = fakeHerdr(happy());
  // A clock that jumps past the deadline before the first look.
  const res = await deliver({ exec, now: clock(5000) });
  assert.equal(res.ok, false);
  assert.match(res.error, /did not settle within 1000ms/);
  assert.deepEqual(calls, [], 'no subprocess was started to spend time it did not have');
});

test('a herdr command that times out is reported as a timeout, not a guess', async () => {
  const { exec } = fakeHerdr({
    ...happy(),
    'pane process-info': { status: 1, stdout: '', stderr: 'timed out after 400ms', timedOut: true },
  });
  const res = await deliver({ exec });
  assert.equal(res.ok, false);
  assert.match(res.error, /pane process-info/);
  assert.equal(asked.length, 0);
});

// ---------------------------------------------------------------------------
// Refusals before any native call

test('delivery refuses before any native call when the slot is not configured', async () => {
  const { exec, calls } = fakeHerdr(happy());
  const res = await deliver({ exec, config: { issueTabLabel: 'Crew' } });
  assert.equal(res.ok, false);
  assert.match(res.error, /issuePaneLabel/);
  assert.deepEqual(calls, []);
});

test('an identifier that is not a Linear identifier never reaches a host', async () => {
  // Shell metacharacters, path traversal and an embedded newline: none of them can mean
  // anything downstream any more, and none of them gets that far.
  for (const bad of ['', 'BIT 1', 'BIT-1; rm -rf /', '../../etc/hosts', 'BIT-1\nBIT-2', null]) {
    const { exec, calls } = fakeHerdr(happy());
    const res = await deliver({ exec, identifier: bad });
    assert.equal(res.ok, false, JSON.stringify(bad));
    assert.match(res.error, /not a Linear issue identifier/);
    assert.deepEqual(calls, []);
  }
});

test('a worktree reply we cannot trust stops delivery before any inventory', async () => {
  const { exec, calls } = fakeHerdr(happy());
  const res = await deliver({ exec, worktreeStdout: '{"result":{"workspace":{}}}' });
  assert.equal(res.ok, false);
  assert.match(res.error, /no workspace id/);
  assert.deepEqual(calls, []);
});

test('failed or malformed native replies produce a diagnostic, not a guess', async () => {
  for (const [key, handler, expected] of [
    ['tab list', { status: 1, stderr: 'workspace_not_found' }, /tab list failed: workspace_not_found/],
    ['pane list', 'not json', /pane list returned unparseable output/],
    ['pane process-info', JSON.stringify({ result: [] }), /pane process-info returned no result/],
    ['pane get', paneReply({ pane_id: 'w9:p9' }), /pane get answered for w9:p9/],
  ]) {
    const { exec, calls } = fakeHerdr({ ...happy(), [key]: handler });
    const res = await deliver({ exec });
    assert.equal(res.ok, false, key);
    assert.match(res.error, expected);
    assertReadOnly(calls);
  }
});
