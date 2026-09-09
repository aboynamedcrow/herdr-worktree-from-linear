import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildViewerCommand, classifyForeground, deliverIssueDetails, readWorktreeWorkspace,
  selectSlot, shellQuote, slotSettings, viewerMetadataArgs, viewerMetadataClearArgs,
  ISSUE_TOKEN, INVOCATION_TOKEN, VIEWER_SCRIPT,
} from '../lib/slot.js';

const WS = 'w9';
const TAB = 'w9:t1';
const SLOT = 'w9:p2';
const CONFIG = { issueTabLabel: 'Crew', issuePaneLabel: 'Issue / Utility', issueSlotSettleMs: 1000, issueSlotPollMs: 200 };

// Reply shapes copied from herdr 0.9.0 captures: `result` wraps a typed payload, and the
// CLI prints it as JSON with no --json flag.
const tabsReply = (tabs) => JSON.stringify({ id: 'cli:tab:list', result: { type: 'tab_list', tabs } });
const panesReply = (panes) => JSON.stringify({ id: 'cli:pane:list', result: { type: 'pane_list', panes } });
const processReply = (info) => JSON.stringify({ id: 'cli:pane:process_info', result: { type: 'pane_process_info', process_info: info } });
const paneReply = (p) => JSON.stringify({ id: 'cli:pane:get', result: { type: 'pane_info', pane: p } });

const tab = (over = {}) => ({ tab_id: TAB, workspace_id: WS, number: 1, label: 'Crew', focused: true, pane_count: 4, agent_status: 'unknown', ...over });
const pane = (over = {}) => ({ pane_id: SLOT, tab_id: TAB, workspace_id: WS, terminal_id: 't', focused: false, agent_status: 'unknown', revision: 0, label: 'Issue / Utility', ...over });

// An idle login shell: one foreground process, and it is the shell process itself.
const idleShell = (over = {}) => ({
  pane_id: SLOT,
  shell_pid: 22278,
  foreground_process_group_id: 22278,
  foreground_processes: [{ pid: 22278, name: 'zsh', argv0: 'zsh', argv: ['-zsh'], cwd: '/wt/bit-1' }],
  ...over,
});

// A job in the foreground: the process group is no longer the shell's.
const busyShell = () => ({
  pane_id: SLOT,
  shell_pid: 87005,
  foreground_process_group_id: 87212,
  foreground_processes: [{ pid: 87212, name: 'cat', argv0: 'cat', argv: ['cat'], cwd: '/wt/bit-1' }],
});

const viewerFor = (issue, invocation) => ({
  pane_id: SLOT,
  shell_pid: 22278,
  foreground_process_group_id: 30001,
  foreground_processes: [{
    pid: 30001,
    name: 'node',
    argv0: 'node',
    argv: [process.execPath, VIEWER_SCRIPT, '--issue', issue, '--invocation', invocation, '--pane', SLOT],
  }],
});

const worktreeStdout = (over = {}) => JSON.stringify({
  id: 'cli:worktree:create',
  result: {
    type: 'worktree_created',
    workspace: { workspace_id: WS, number: 8, label: 'BIT-1', focused: true, pane_count: 4, tab_count: 1, active_tab_id: TAB, agent_status: 'unknown' },
    tab: tab(),
    root_pane: pane({ pane_id: 'w9:p1', label: 'Orchestrator' }),
    worktree: { path: '/wt/bit-1', label: 'bit-1', is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true },
    ...over,
  },
});

// Dispatches on the first two CLI words ("pane list", "pane process-info", ...). A handler
// is a JSON string, a { status, stdout, stderr } triple, or a function of the call index.
function fakeHerdr(handlers) {
  const calls = [];
  const seen = new Map();
  const exec = (cmd, args = []) => {
    calls.push([cmd, ...args]);
    const key = `${args[0]} ${args[1]}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    const handler = handlers[key];
    if (handler === undefined) return { status: 1, stdout: '', stderr: `unexpected ${key}` };
    const out = typeof handler === 'function' ? handler(nth, args) : handler;
    if (typeof out === 'string') return { status: 0, stdout: out, stderr: '' };
    return { status: out.status ?? 0, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
  };
  return { exec, calls };
}

// A clock that steps by one poll each read, so the settle deadline is reached without any
// real waiting.
function clock(step = 200) {
  let t = 0;
  return () => { const v = t; t += step; return v; };
}

const deliver = (over = {}) => deliverIssueDetails({
  worktreeStdout: worktreeStdout(),
  identifier: 'BIT-1',
  config: CONFIG,
  configDir: '/cfg',
  herdrBin: 'herdr',
  sleep: async () => {},
  now: clock(),
  invocation: () => 'inv0',
  ...over,
});

const happy = () => ({
  'tab list': tabsReply([tab()]),
  'pane list': panesReply([pane({ pane_id: 'w9:p1', label: 'Orchestrator' }), pane()]),
  'pane process-info': processReply(idleShell()),
  'pane run': { status: 0, stdout: '', stderr: '' },
});

// Layout is created out of band, so anything that opens, moves, resizes or closes a pane
// would be this plugin rearranging a layout it did not build.
const MUTATORS = ['split', 'swap', 'move', 'resize', 'close', 'zoom', 'open'];
function assertReadOnlyLayout(calls) {
  for (const call of calls) {
    for (const verb of MUTATORS) {
      assert.equal(call.includes(verb), false, `must not run: ${call.join(' ')}`);
    }
  }
}

test('shellQuote survives quotes, spaces and shell metacharacters', () => {
  assert.equal(shellQuote('BIT-1'), "'BIT-1'");
  assert.equal(shellQuote("it's; rm -rf /"), "'it'\\''s; rm -rf /'");
  assert.equal(shellQuote('/a b/$(id)'), "'/a b/$(id)'");
});

test('buildViewerCommand pins node, script, config and cwd, and quotes every argument', () => {
  const built = buildViewerCommand({
    nodePath: '/usr/bin/node', scriptPath: '/p/bin/issue.js', identifier: 'BIT-1',
    invocation: 'inv0', configDir: '/cfg', cwd: '/wt/bit-1', paneId: SLOT,
  });
  assert.equal(built.ok, true);
  assert.equal(built.command,
    "'/usr/bin/node' '/p/bin/issue.js' '--issue' 'BIT-1' '--invocation' 'inv0' '--config-dir' '/cfg' '--cwd' '/wt/bit-1' '--pane' 'w9:p2'");
});

test('buildViewerCommand refuses arguments that cannot be typed as one line', () => {
  const bad = (identifier) => buildViewerCommand({
    nodePath: '/usr/bin/node', scriptPath: '/p/bin/issue.js', identifier,
    invocation: 'inv0', configDir: '/cfg', cwd: '/wt', paneId: SLOT,
  });
  // A newline would submit a second command at the prompt.
  assert.equal(bad('BIT-1\nrm -rf /').ok, false);
  assert.equal(bad('BIT-\t1').ok, false);
  assert.equal(bad('').ok, false);
});

test('slotSettings requires both labels and never invents one', () => {
  assert.match(slotSettings({}).error, /issueTabLabel and issuePaneLabel/);
  assert.match(slotSettings({ issueTabLabel: 'Crew' }).error, /issuePaneLabel/);
  const ok = slotSettings(CONFIG);
  assert.deepEqual([ok.ok, ok.tabLabel, ok.paneLabel, ok.settleMs, ok.pollMs], [true, 'Crew', 'Issue / Utility', 1000, 200]);
  // Nonsense timings fall back to the built-in bounds rather than disabling the deadline.
  const defaults = slotSettings({ issueTabLabel: 'a', issuePaneLabel: 'b', issueSlotSettleMs: -1, issueSlotPollMs: 0 });
  assert.ok(defaults.settleMs > 0 && defaults.settleMs <= 60000);
  assert.ok(defaults.pollMs > 0 && defaults.pollMs <= defaults.settleMs);
});

test('readWorktreeWorkspace takes the workspace from the reply, and rejects an incoherent one', () => {
  const good = readWorktreeWorkspace(worktreeStdout());
  assert.deepEqual([good.ok, good.workspaceId, good.checkoutPath], [true, WS, '/wt/bit-1']);
  assert.match(readWorktreeWorkspace('not json').error, /unparseable/);
  assert.match(readWorktreeWorkspace('{"result":{}}').error, /no workspace id/);
  // A tab that belongs to a different workspace means the reply is not one workspace.
  const crossed = worktreeStdout({ tab: tab({ workspace_id: 'wOTHER' }) });
  assert.match(readWorktreeWorkspace(crossed).error, /tab belongs to wOTHER/);
  const crossedPane = worktreeStdout({ root_pane: pane({ pane_id: 'wX:p1', workspace_id: 'wX' }) });
  assert.match(readWorktreeWorkspace(crossedPane).error, /root pane belongs to wX/);
});

test('selectSlot demands exactly one labeled tab and one labeled pane inside it', () => {
  const panes = [pane(), pane({ pane_id: 'w9:p3', label: 'Worker 1' })];
  assert.deepEqual(selectSlot([tab()], panes, WS, 'Crew', 'Issue / Utility'), { ok: true, tabId: TAB, paneId: SLOT });
  // Renamed tab.
  assert.match(selectSlot([tab({ label: 'Renamed Crew' })], panes, WS, 'Crew', 'Issue / Utility').error, /no tab labeled/);
  // Duplicated tab: two candidates, so there is nothing to pick.
  assert.match(selectSlot([tab(), tab({ tab_id: 'w9:t2' })], panes, WS, 'Crew', 'Issue / Utility').error, /2 tabs labeled .*w9:t1, w9:t2/);
  // Renamed slot.
  assert.match(selectSlot([tab()], [pane({ label: 'Notes' })], WS, 'Crew', 'Issue / Utility').error, /no pane labeled/);
  // Duplicated slot.
  assert.match(selectSlot([tab()], [pane(), pane({ pane_id: 'w9:p5' })], WS, 'Crew', 'Issue / Utility').error, /2 panes labeled/);
  // A pane in another workspace, or in another tab, is not this slot.
  assert.match(selectSlot([tab()], [pane({ workspace_id: 'wX' })], WS, 'Crew', 'Issue / Utility').error, /no pane labeled/);
  assert.match(selectSlot([tab()], [pane({ tab_id: 'w9:t7' })], WS, 'Crew', 'Issue / Utility').error, /no pane labeled/);
  // Malformed inventory is a failure, never an empty match set treated as "renamed".
  assert.match(selectSlot(null, panes, WS, 'Crew', 'Issue / Utility').error, /no tabs/);
  assert.match(selectSlot([tab()], null, WS, 'Crew', 'Issue / Utility').error, /no panes/);
});

test('classifyForeground only calls it a shell when the shell itself is in front', () => {
  assert.equal(classifyForeground(idleShell(), SLOT).kind, 'shell');
  assert.equal(classifyForeground(busyShell(), SLOT).kind, 'busy');
  // The right name but a different pid: a remembered shell pid is not ownership.
  const impostor = idleShell({ foreground_processes: [{ pid: 999, name: 'zsh', argv: ['-zsh'] }], foreground_process_group_id: 999 });
  assert.equal(classifyForeground(impostor, SLOT).kind, 'busy');
  // The shell's own pid, but a job holds the foreground process group.
  assert.equal(classifyForeground(idleShell({ foreground_process_group_id: 41 }), SLOT).kind, 'busy');
  // Something we do not recognize is never typed into.
  const unknown = idleShell({ foreground_processes: [{ pid: 22278, name: 'claude', argv: ['claude'] }] });
  assert.equal(classifyForeground(unknown, SLOT).kind, 'unknown');
  assert.equal(classifyForeground(idleShell({ foreground_processes: [] }), SLOT).kind, 'unknown');
  assert.equal(classifyForeground(idleShell({ shell_pid: null }), SLOT).kind, 'busy');
  assert.equal(classifyForeground(null, SLOT).kind, 'unknown');
  // Process info about a different pane answers a different question.
  assert.equal(classifyForeground(idleShell(), 'w9:p7').kind, 'unknown');
  // Two foreground processes: a pipeline is running.
  const pipeline = idleShell({ foreground_processes: [{ pid: 1, name: 'zsh' }, { pid: 2, name: 'grep' }] });
  assert.equal(classifyForeground(pipeline, SLOT).kind, 'busy');
});

test('classifyForeground reads our viewer identity out of its live argv', () => {
  const seen = classifyForeground(viewerFor('BIT-1', 'inv7'), SLOT);
  assert.deepEqual([seen.kind, seen.issue, seen.invocation], ['viewer', 'BIT-1', 'inv7']);
  // A node process that is not our script is just another foreground process.
  const other = viewerFor('BIT-1', 'inv7');
  other.foreground_processes[0].argv = [process.execPath, '/elsewhere/app.js'];
  assert.equal(classifyForeground(other, SLOT).kind, 'busy');
});

test('delivery types the viewer command into a uniquely identified idle shell', async () => {
  const { exec, calls } = fakeHerdr(happy());
  const out = await deliver({ exec });
  assert.deepEqual([out.ok, out.action, out.paneId, out.invocation], [true, 'launched', SLOT, 'inv0']);
  const run = calls.find((c) => c[1] === 'pane' && c[2] === 'run');
  assert.deepEqual(run.slice(0, 4), ['herdr', 'pane', 'run', SLOT]);
  assert.equal(run[4],
    `${shellQuote(process.execPath)} ${shellQuote(VIEWER_SCRIPT)} '--issue' 'BIT-1' '--invocation' 'inv0' '--config-dir' '/cfg' '--cwd' '/wt/bit-1' '--pane' 'w9:p2'`);
  // Inventory is always workspace-scoped: the focused pane belongs to whoever is at the
  // keyboard, which may be another client entirely.
  for (const c of calls.filter((x) => x[2] === 'list')) assert.ok(c.includes('--workspace') && c.includes(WS));
  assert.equal(calls.some((c) => c[2] === 'current' || c[2] === 'focus'), false);
  assertReadOnlyLayout(calls);
});

test('delivery waits out a layout that has not been applied yet', async () => {
  // The tab exists from the start, the slot pane only appears on the third look.
  const { exec, calls } = fakeHerdr({
    ...happy(),
    'pane list': (nth) => panesReply(nth < 2 ? [pane({ pane_id: 'w9:p1', label: 'Orchestrator' })] : [pane()]),
  });
  const out = await deliver({ exec });
  assert.deepEqual([out.ok, out.action], [true, 'launched']);
  assert.ok(calls.filter((c) => c[1] === 'pane' && c[2] === 'list').length >= 3, 'polled until the slot appeared');
});

test('delivery gives up on a finite deadline and reports what it last saw', async () => {
  const { exec, calls } = fakeHerdr({ ...happy(), 'pane list': panesReply([pane({ label: 'Notes' })]) });
  const out = await deliver({ exec });
  assert.equal(out.ok, false);
  assert.match(out.error, /no pane labeled "Issue \/ Utility"/);
  assert.equal(calls.some((c) => c[2] === 'run'), false, 'nothing was typed anywhere');
  // settleMs 1000 / pollMs 200 is a bounded number of looks, not an open-ended wait.
  assert.ok(calls.filter((c) => c[1] === 'pane' && c[2] === 'list').length <= 8);
  assertReadOnlyLayout(calls);
});

test('a repeat delivery focuses the same viewer and sends it no input', async () => {
  const { exec, calls } = fakeHerdr({
    ...happy(),
    'pane process-info': processReply(viewerFor('BIT-1', 'inv7')),
    'pane get': paneReply(pane({ tokens: { [ISSUE_TOKEN]: 'BIT-1', [INVOCATION_TOKEN]: 'inv7' } })),
    'pane focus': { status: 0, stdout: '', stderr: '' },
  });
  const out = await deliver({ exec });
  assert.deepEqual([out.ok, out.action, out.paneId], [true, 'focused', SLOT]);
  assert.deepEqual(calls.find((c) => c[2] === 'focus'), ['herdr', 'pane', 'focus', SLOT]);
  assert.equal(calls.some((c) => c[2] === 'run' || c[2] === 'send-text' || c[2] === 'send-keys'), false);
  assertReadOnlyLayout(calls);
});

test('a viewer for another issue is busy, not something to take over', async () => {
  const { exec, calls } = fakeHerdr({
    ...happy(),
    'pane process-info': processReply(viewerFor('BIT-9', 'inv9')),
    'pane get': paneReply(pane({ tokens: { [ISSUE_TOKEN]: 'BIT-9', [INVOCATION_TOKEN]: 'inv9' } })),
  });
  const out = await deliver({ exec });
  assert.equal(out.ok, false);
  assert.match(out.error, /another issue viewer for BIT-9/);
  assert.equal(calls.some((c) => c[2] === 'run' || c[2] === 'focus'), false);
});

test('metadata left behind by an exited viewer never counts as a live one', async () => {
  // The pane still carries this issue's tokens, but the foreground process is a viewer
  // from a different invocation — the token could only have been left by a dead process.
  const { exec, calls } = fakeHerdr({
    ...happy(),
    'pane process-info': processReply(viewerFor('BIT-1', 'inv-live')),
    'pane get': paneReply(pane({ tokens: { [ISSUE_TOKEN]: 'BIT-1', [INVOCATION_TOKEN]: 'inv-stale' } })),
  });
  const out = await deliver({ exec });
  assert.equal(out.ok, false);
  assert.equal(calls.some((c) => c[2] === 'focus'), false);
  // And with the tokens gone entirely, argv alone is still not agreement.
  const bare = fakeHerdr({
    ...happy(),
    'pane process-info': processReply(viewerFor('BIT-1', 'inv-live')),
    'pane get': paneReply(pane({ tokens: {} })),
  });
  const second = await deliver({ exec: bare.exec });
  assert.equal(second.ok, false);
  assert.equal(bare.calls.some((c) => c[2] === 'focus'), false);
});

test('a busy or unrecognized foreground process is reported, never typed into', async () => {
  for (const [info, pattern] of [
    [busyShell(), /cat is running/],
    [idleShell({ foreground_processes: [{ pid: 22278, name: 'claude', argv: ['claude'] }] }), /unrecognized foreground process claude/],
    [idleShell({ foreground_processes: [] }), /no foreground process/],
  ]) {
    const { exec, calls } = fakeHerdr({ ...happy(), 'pane process-info': processReply(info) });
    const out = await deliver({ exec });
    assert.equal(out.ok, false);
    assert.match(out.error, pattern);
    assert.equal(calls.some((c) => c[2] === 'run'), false);
    assertReadOnlyLayout(calls);
  }
});

test('an identity that goes stale between the check and the write stops the write', async () => {
  // Idle on the first look, a job in the foreground on the revalidation pass.
  const { exec, calls } = fakeHerdr({
    ...happy(),
    'pane process-info': (nth) => processReply(nth === 0 ? idleShell() : busyShell()),
  });
  const out = await deliver({ exec });
  assert.equal(out.ok, false);
  assert.match(out.error, /stopped being a shell prompt/);
  assert.equal(calls.some((c) => c[2] === 'run'), false);

  // Renamed out from under us between the check and the write.
  const renamed = fakeHerdr({
    ...happy(),
    'pane list': (nth) => panesReply(nth === 0 ? [pane()] : [pane({ pane_id: 'w9:p6' })]),
  });
  const moved = await deliver({ exec: renamed.exec });
  assert.equal(moved.ok, false);
  assert.match(moved.error, /slot moved from w9:p2 to w9:p6/);
  assert.equal(renamed.calls.some((c) => c[2] === 'run'), false);
});

test('failed or malformed native replies produce a diagnostic, not a guess', async () => {
  const cases = [
    [{ ...happy(), 'tab list': { status: 1, stdout: '', stderr: 'no such workspace' } }, /tab list failed: no such workspace/],
    [{ ...happy(), 'pane list': { status: 0, stdout: 'not json', stderr: '' } }, /pane list returned unparseable/],
    [{ ...happy(), 'pane list': { status: 0, stdout: '{"id":"x"}', stderr: '' } }, /pane list returned no result/],
    [{ ...happy(), 'pane process-info': { status: 1, stdout: '', stderr: 'pane gone' } }, /process-info failed: pane gone/],
    [{ ...happy(), 'pane run': { status: 1, stdout: '', stderr: 'send failed' } }, /pane run failed: send failed/],
  ];
  for (const [handlers, pattern] of cases) {
    const { exec, calls } = fakeHerdr(handlers);
    const out = await deliver({ exec });
    assert.equal(out.ok, false);
    assert.match(out.error, pattern);
    assertReadOnlyLayout(calls);
  }
  // process-info about some other pane is not evidence about this one.
  const { exec } = fakeHerdr({ ...happy(), 'pane process-info': processReply(idleShell({ pane_id: 'w9:p8' })) });
  assert.match((await deliver({ exec })).error, /process information is for w9:p8/);
});

test('delivery refuses before any native call when the slot is not configured', async () => {
  const { exec, calls } = fakeHerdr(happy());
  const out = await deliver({ exec, config: { issueTabLabel: 'Crew' } });
  assert.equal(out.ok, false);
  assert.match(out.error, /issuePaneLabel/);
  assert.deepEqual(calls, []);
});

test('a worktree reply we cannot trust stops delivery before any inventory', async () => {
  const { exec, calls } = fakeHerdr(happy());
  const out = await deliver({ exec, worktreeStdout: '{"result":{}}' });
  assert.equal(out.ok, false);
  assert.match(out.error, /no workspace id/);
  assert.deepEqual(calls, []);
});

test('viewer metadata args publish and clear the same two tokens', () => {
  assert.deepEqual(viewerMetadataArgs(SLOT, 'BIT-1', 'inv0'), [
    'pane', 'report-metadata', SLOT, '--source', 'tdi.worktree-from-linear',
    '--token', `${ISSUE_TOKEN}=BIT-1`, '--token', `${INVOCATION_TOKEN}=inv0`,
  ]);
  assert.deepEqual(viewerMetadataClearArgs(SLOT), [
    'pane', 'report-metadata', SLOT, '--source', 'tdi.worktree-from-linear',
    '--clear-token', ISSUE_TOKEN, '--clear-token', INVOCATION_TOKEN,
  ]);
});
