import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../lib/run.js';
import { plusFixture } from './support/plus-fixture.js';
import { HOST_SCRIPT, checkoutDigest } from '../lib/hostwire.js';

const SAMPLE = JSON.stringify({ data: { issues: { nodes: [
  { identifier: 'BIT-1', title: 'Do it', branchName: 'tdi/bit-1-do-it', url: 'u', state: { name: 'Todo' }, assignee: { displayName: 'D' }, team: { key: 'BIT' } },
] } } });

function keyDir(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wfl-run-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ linearApiKey: 'k', ...config }));
  return dir;
}

const backend = plusFixture();
after(() => backend.close());
function fakeExec() {
  const calls = [];
  const exec = (cmd, args = [], opts = {}) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git' && args.includes('--porcelain')) return { status: 0, stdout: `worktree ${args[1]}\nHEAD abc\n`, stderr: '' };
    return backend.reply(cmd, args, opts) || { status: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

test('run delegates identifier and title to the shared policy and applies its choice', async () => {
  const dir = keyDir();
  const { exec, calls } = fakeExec();
  const fetchFn = async () => ({ ok: true, status: 200, text: async () => SAMPLE });
  const code = await run({ env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_WFP_CWD: '/repo', HERDR_BIN_PATH: 'herdr' }, exec, fetchFn, select: async (list) => list[0], log: () => {} });
  assert.equal(code, 0);
  const plan = calls.find((c) => c[1] === 'plan-worktree');
  assert.deepEqual(plan.slice(2), ['--cwd', '/repo', '--name', 'Do it', '--issue', 'BIT-1']);
  assert.ok(calls.some((c) => c[1] === 'apply-worktree' && c.includes(backend.plan.fingerprint)));
  assert.equal(calls.some((c) => c.includes('fetch') || c.includes('create')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('run selects the Linear API key using the resolved repo root', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wfl-run-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    linearApiKeyEnvByPath: [{ contains: 'hsys', env: 'LINEAR_API_KEY_MATCH' }],
    linearApiKeyEnvDefault: 'LINEAR_API_KEY_DEFAULT',
  }));
  const { exec: baseExec } = fakeExec();
  const exec = (cmd, args = []) => {
    if (cmd === 'git' && args.includes('--porcelain')) {
      return { status: 0, stdout: 'worktree /repo/HSYS\nHEAD abc\n', stderr: '' };
    }
    return baseExec(cmd, args);
  };
  const fetchFn = async (_url, options) => {
    assert.equal(options.headers.Authorization, 'test-key-1');
    return { ok: true, status: 200, text: async () => '{"data":{"issues":{"nodes":[]}}}' };
  };
  const env = {
    HERDR_PLUGIN_CONFIG_DIR: dir,
    HERDR_WFP_CWD: '/repo/HSYS',
    LINEAR_API_KEY_MATCH: 'test-key-1',
    LINEAR_API_KEY_DEFAULT: 'test-key-default',
  };
  assert.equal(await run({ env, exec, fetchFn, log: () => {} }), 0);
  rmSync(dir, { recursive: true, force: true });
});

// A linked checkout and its main checkout can match different key rules. The key
// follows the invoking checkout, as it did before main-worktree selection.
test('run selects the Linear API key from the linked checkout, not the main worktree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wfl-run-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    linearApiKeyEnvByPath: [{ contains: 'hsys', env: 'LINEAR_API_KEY_MATCH' }],
    linearApiKeyEnvDefault: 'LINEAR_API_KEY_DEFAULT',
  }));
  const { exec: baseExec, calls } = fakeExec();
  const exec = (cmd, args = []) => {
    if (cmd === 'git' && args.includes('--porcelain')) {
      return { status: 0, stdout: 'worktree /repos/shared-api\nHEAD abc\n\nworktree /worktrees/hsys/shared-api\nHEAD def\n', stderr: '' };
    }
    return baseExec(cmd, args);
  };
  const fetchFn = async (_url, options) => {
    assert.equal(options.headers.Authorization, 'test-key-1');
    return { ok: true, status: 200, text: async () => SAMPLE };
  };
  const env = {
    HERDR_PLUGIN_CONFIG_DIR: dir,
    HERDR_WFP_CWD: '/worktrees/hsys/shared-api',
    HERDR_BIN_PATH: 'herdr',
    LINEAR_API_KEY_MATCH: 'test-key-1',
    LINEAR_API_KEY_DEFAULT: 'test-key-default',
  };
  assert.equal(await run({ env, exec, fetchFn, select: async (list) => list[0], log: () => {} }), 0);
  const plan = calls.find((c) => c[1] === 'plan-worktree');
  assert.deepEqual(plan.slice(2, 4), ['--cwd', '/repos/shared-api']);   // Plus still plans from main.
  rmSync(dir, { recursive: true, force: true });
});

// Native replies in the shape herdr 0.9.0 prints them, for the slot delivery path.
const WS = 'w9';
const TAB = 'w9:t1';
const SLOT = 'w9:p2';
const CHECKOUT = '/wt/bit-1';
const INSTANCE = 'instance-token-0';
const WORKTREE_OUT = JSON.stringify({ result: {
  type: 'worktree_created',
  workspace: { workspace_id: WS, active_tab_id: TAB, label: 'BIT-1', number: 1, focused: true, pane_count: 2, tab_count: 1, agent_status: 'unknown' },
  tab: { tab_id: TAB, workspace_id: WS, label: 'Crew', number: 1, focused: true, pane_count: 2, agent_status: 'unknown' },
  root_pane: { pane_id: 'w9:p1', tab_id: TAB, workspace_id: WS, terminal_id: 't1', focused: true, agent_status: 'unknown', revision: 0, label: 'Orchestrator' },
  worktree: { branch: 'ingwon/bit-1-do-it', path: CHECKOUT, label: 'bit-1', is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true },
} });
const SLOT_CONFIG = { showIssueDetails: true, issueTabLabel: 'Crew', issuePaneLabel: 'Issue / Utility', issueSlotSettleMs: 200, issueSlotPollMs: 200 };

// A pane whose foreground process is an issue host. The pid is this test process: it is a
// live node process, which is what the driver requires before it will talk to anything.
const HOST_FRONT = {
  pane_id: SLOT,
  shell_pid: 42,
  foreground_process_group_id: process.pid,
  foreground_processes: [{
    pid: process.pid,
    name: 'node',
    argv0: 'node',
    argv: [process.execPath, HOST_SCRIPT, '--pane', SLOT, '--config-dir', '/cfg', '--cwd', CHECKOUT],
  }],
};
// A slot with no host in it: a shell at what looks like an idle prompt.
const SHELL_FRONT = { pane_id: SLOT, shell_pid: 42, foreground_process_group_id: 42, foreground_processes: [{ pid: 42, name: 'zsh', argv0: 'zsh', argv: ['-zsh'] }] };

const hostTokens = (socketPath) => ({
  'wfl-host-pid': String(process.pid),
  'wfl-host-id': INSTANCE,
  'wfl-host-sock': socketPath,
  'wfl-host-cwd': checkoutDigest(CHECKOUT),
});

// A real unix socket speaking the host protocol, so run() reaches it the way it would
// reach a host: over lib/hostwire.js, with no injection.
async function hostServer(t, status = 'accepted') {
  const dir = mkdtempSync(join(tmpdir(), 'wfl-run-host-'));
  const socketPath = join(dir, 'h.sock');
  const seen = [];
  const server = createServer((conn) => {
    let buffer = '';
    conn.setEncoding('utf8');
    conn.on('error', () => {});
    conn.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      seen.push(request);
      conn.end(`${JSON.stringify({
        protocol: 'wfl-host-1', id: request.id, ok: true, status,
        pane: request.pane, host: request.host, pid: request.pid, checkout: request.checkout,
        issue: request.issue, detail: status,
      })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  return { socketPath, seen };
}

// git answers plus a herdr that owns a laid-out Crew tab with one Issue / Utility slot.
function slotExec({ worktreeExists = false, processInfo = HOST_FRONT, paneTokens = {} } = {}) {
  const calls = [];
  const options = [];
  const exec = (cmd, args = [], opts = {}) => {
    calls.push([cmd, ...args]);
    options.push(opts);
    if (cmd === 'git' && args.includes('--porcelain')) return { status: 0, stdout: `worktree ${args[1]}\nHEAD abc\n`, stderr: '' };
    const shared = backend.reply(cmd, args, opts, { checkout: worktreeExists, output: WORKTREE_OUT });
    if (shared) return shared;
    if (args[0] === 'tab' && args[1] === 'list') {
      return { status: 0, stdout: JSON.stringify({ result: { type: 'tab_list', tabs: [{ tab_id: TAB, workspace_id: WS, label: 'Crew', number: 1, focused: true, pane_count: 2, agent_status: 'unknown' }] } }), stderr: '' };
    }
    if (args[0] === 'pane' && args[1] === 'list') {
      return { status: 0, stdout: JSON.stringify({ result: { type: 'pane_list', panes: [
        { pane_id: 'w9:p1', tab_id: TAB, workspace_id: WS, terminal_id: 't1', focused: true, agent_status: 'unknown', revision: 0, label: 'Orchestrator' },
        { pane_id: SLOT, tab_id: TAB, workspace_id: WS, terminal_id: 't2', focused: false, agent_status: 'unknown', revision: 0, label: 'Issue / Utility' },
      ] } }), stderr: '' };
    }
    if (args[0] === 'pane' && args[1] === 'process-info') {
      return { status: 0, stdout: JSON.stringify({ result: { type: 'pane_process_info', process_info: processInfo } }), stderr: '' };
    }
    if (args[0] === 'pane' && args[1] === 'get') {
      return { status: 0, stdout: JSON.stringify({ result: { type: 'pane_info', pane: {
        pane_id: SLOT, tab_id: TAB, workspace_id: WS, terminal_id: 't2', focused: false,
        agent_status: 'unknown', revision: 0, label: 'Issue / Utility', tokens: paneTokens,
      } } }), stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { exec, calls, options };
}

// Nothing this plugin runs may write to a terminal or rearrange a layout.
const FORBIDDEN = ['run', 'send-input', 'send-keys', 'paste', 'split', 'swap', 'move', 'resize', 'zoom', 'close'];
function assertReadOnly(calls) {
  for (const c of calls) {
    for (const verb of FORBIDDEN) assert.equal(c.includes(verb), false, `must not run: ${c.join(' ')}`);
  }
}

async function runWithSlot(dir, { exec, select = async (list) => list[0], log = () => {}, socketPath } = {}) {
  return run({
    env: {
      HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_WFP_CWD: '/repo', HERDR_BIN_PATH: 'herdr',
      HERDR_PLUGIN_ID: 'tdi.worktree-from-linear', HERDR_SOCKET_PATH: socketPath,
    },
    exec,
    fetchFn: async () => ({ ok: true, status: 200, text: async () => SAMPLE }),
    select,
    log,
  });
}

test('run hands the issue to the host in the configured slot of the new workspace', async (t) => {
  const dir = keyDir(SLOT_CONFIG);
  const host = await hostServer(t);
  const { exec, calls } = slotExec({ paneTokens: hostTokens(host.socketPath) });
  const logs = [];
  assert.equal(await runWithSlot(dir, { exec, log: (m) => logs.push(m) }), 0);
  // The host was asked, over its own socket, for exactly the issue that was picked.
  assert.equal(host.seen.length, 1, JSON.stringify(logs));
  assert.equal(host.seen[0].op, 'show');
  assert.equal(host.seen[0].issue, 'BIT-1');
  assert.equal(host.seen[0].pane, SLOT);
  assert.equal(host.seen[0].checkout, CHECKOUT);
  assert.equal(logs.some((m) => /not delivered/.test(m)), false, logs.join(' | '));
  assertReadOnly(calls);
  // The workspace id comes from the worktree reply, never from whoever has focus.
  for (const c of calls.filter((x) => ['pane', 'tab'].includes(x[1]) && x[2] === 'list')) assert.ok(c.includes(WS));
  assert.equal(calls.some((c) => c[2] === 'current'), false);
  rmSync(dir, { recursive: true, force: true });
});

// The old behavior skipped re-opens because it added a pane every time. Delivery targets
// a slot that is already there, so a re-open is exactly as valid as a fresh create.
test('run also delivers when an existing worktree is re-opened', async (t) => {
  const dir = keyDir(SLOT_CONFIG);
  const host = await hostServer(t);
  const { exec, calls } = slotExec({ worktreeExists: true, paneTokens: hostTokens(host.socketPath) });
  assert.equal(await runWithSlot(dir, { exec }), 0);
  assert.ok(calls.some((c) => c.includes('apply-worktree')), 'shared policy applies the existing checkout');
  assert.equal(host.seen.length, 1, 'the issue was still delivered');
  rmSync(dir, { recursive: true, force: true });
});

test('run never splits, swaps, moves, resizes or types to show the issue', async (t) => {
  const dir = keyDir(SLOT_CONFIG);
  const host = await hostServer(t);
  const { exec, calls } = slotExec({ paneTokens: hostTokens(host.socketPath) });
  assert.equal(await runWithSlot(dir, { exec }), 0);
  assertReadOnly(calls);
  assert.equal(calls.some((c) => c[1] === 'plugin' && c[2] === 'pane'), false, 'no plugin pane is opened');
  rmSync(dir, { recursive: true, force: true });
});

// The worktree and its layout are already right; only the issue view is skipped.
test('a slot with no host leaves the worktree alone and says how to start one', async () => {
  const dir = keyDir(SLOT_CONFIG);
  const { exec, calls, options } = slotExec({ processInfo: SHELL_FRONT });
  const logs = [];
  assert.equal(await runWithSlot(dir, { exec, log: (m) => logs.push(m) }), 0);
  assert.ok(logs.some((m) => /created worktree for BIT-1/.test(m)), 'the worktree still succeeded');
  assert.ok(logs.some((m) => /not running the issue host/.test(m)), 'and said why');
  assert.ok(logs.some((m) => /start it there with: node .*slot-host\.js --pane w9:p2/.test(m)), logs.join(' | '));
  assertReadOnly(calls);
  // Every herdr call delivery makes has a bound, the notification that reports the failure
  // included: a server that accepts a command and never answers cannot hold the picker open.
  for (const [i, call] of calls.entries()) {
    if (call[0] !== 'herdr' || !['pane', 'tab', 'notification'].includes(call[1])) continue;
    assert.equal(typeof options[i].timeout, 'number', `${call.join(' ')} was spawned with no timeout`);
  }
  assert.ok(calls.some((c) => c[1] === 'notification'), 'the failure was notified');
  rmSync(dir, { recursive: true, force: true });
});

test('showIssueDetails without configured slot labels reports instead of guessing one', async () => {
  const dir = keyDir({ showIssueDetails: true });
  const { exec, calls } = slotExec();
  const logs = [];
  assert.equal(await runWithSlot(dir, { exec, log: (m) => logs.push(m) }), 0);
  assert.ok(logs.some((m) => /issueTabLabel and issuePaneLabel/.test(m)));
  assert.equal(calls.some((c) => c[1] === 'pane' || c[1] === 'tab'), false, 'no inventory was even attempted');
  rmSync(dir, { recursive: true, force: true });
});

test('run does NOT touch the slot unless showIssueDetails is set', async () => {
  const dir = keyDir(); // default: showIssueDetails off
  const { exec, calls } = slotExec();
  assert.equal(await runWithSlot(dir, { exec }), 0);
  assert.equal(calls.some((c) => c[1] === 'pane' || c[1] === 'tab'), false);
  rmSync(dir, { recursive: true, force: true });
});

// run() has to hand the socket herdr injected down to delivery: focusing an exact pane
// has no CLI, so without it a repeat delivery could not focus anything.
test('a repeat delivery leaves the current pane focused', async (t) => {
  const dir = keyDir(SLOT_CONFIG);
  const host = await hostServer(t, 'showing');
  const seen = [];
  const socketDir = mkdtempSync(join(tmpdir(), 'wfl-run-sock-'));
  const socketPath = join(socketDir, 's');
  const server = createServer((conn) => {
    let buffer = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      seen.push(request);
      conn.write(`${JSON.stringify({ id: request.id, result: { type: 'pane_info', pane: { pane_id: request.params.pane_id } } })}\n`);
    });
    conn.on('error', () => {});
  });
  t.after(() => { server.close(); rmSync(socketDir, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  const { exec, calls } = slotExec({ paneTokens: hostTokens(host.socketPath) });
  const logs = [];
  assert.equal(await runWithSlot(dir, { exec, log: (m) => logs.push(m), socketPath }), 0);
  assert.deepEqual(seen, []);
  assert.equal(host.seen.length, 1, 'the host confirmed it is showing the issue');
  assertReadOnly(calls);
  assert.equal(logs.some((m) => /not delivered/.test(m)), false, logs.join(' | '));
});

test('cancelling changes nothing: no worktree, no inventory, no input', async () => {
  const dir = keyDir(SLOT_CONFIG);
  const { exec, calls } = slotExec();
  assert.equal(await runWithSlot(dir, { exec, select: async () => null }), 0);
  assert.equal(calls.some((c) => c[0] === 'herdr'), false);
  assert.equal(calls.some((c) => c.includes('fetch')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('run is a no-op when there are no active issues', async () => {
  const dir = keyDir();
  const { exec } = fakeExec();
  const fetchFn = async () => ({ ok: true, status: 200, text: async () => '{"data":{"issues":{"nodes":[]}}}' });
  const logs = [];
  const code = await run({ env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_WFP_CWD: '/repo' }, exec, fetchFn, select: async () => null, log: (m) => logs.push(m) });
  assert.equal(code, 0);
  assert.ok(logs.some((m) => /no active issues/.test(m)));
  rmSync(dir, { recursive: true, force: true });
});

test('run is a no-op when the user cancels', async () => {
  const dir = keyDir();
  const { exec, calls } = fakeExec();
  const fetchFn = async () => ({ ok: true, status: 200, text: async () => SAMPLE });
  const code = await run({ env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_WFP_CWD: '/repo' }, exec, fetchFn, select: async () => null, log: () => {} });
  assert.equal(code, 0);
  assert.equal(calls.some((c) => c.includes('fetch')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('run routes the worktree to the repo mapped to the issue team', async () => {
  const dir = keyDir({ repos: { BIT: '/mapped-repo' } });
  const { exec, calls } = fakeExec();
  const fetchFn = async () => ({ ok: true, status: 200, text: async () => SAMPLE });
  const code = await run({ env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_WFP_CWD: '/repo', HERDR_BIN_PATH: 'herdr' }, exec, fetchFn, select: async (list) => list[0], log: () => {} });
  assert.equal(code, 0);
  const create = calls.find((c) => c[1] === 'plan-worktree');
  assert.ok(create.includes('/mapped-repo'));
  assert.ok(!create.includes('/repo'));
  rmSync(dir, { recursive: true, force: true });
});

test('run falls back to the invoking repo for an unmapped team', async () => {
  const dir = keyDir({ repos: { OTHER: '/elsewhere' } });
  const { exec, calls } = fakeExec();
  const fetchFn = async () => ({ ok: true, status: 200, text: async () => SAMPLE });
  const code = await run({ env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_WFP_CWD: '/repo', HERDR_BIN_PATH: 'herdr' }, exec, fetchFn, select: async (list) => list[0], log: () => {} });
  assert.equal(code, 0);
  assert.ok(calls.find((c) => c[1] === 'plan-worktree').includes('/repo'));
  rmSync(dir, { recursive: true, force: true });
});

test('run labels the new workspace with the issue identifier', async () => {
  const dir = keyDir();
  const { exec, calls } = fakeExec();
  const fetchFn = async () => ({ ok: true, status: 200, text: async () => SAMPLE });
  await run({ env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_WFP_CWD: '/repo', HERDR_BIN_PATH: 'herdr' }, exec, fetchFn, select: async (l) => l[0], log: () => {} });
  const report = calls.find((c) => c.includes('report-metadata'));
  assert.ok(report, 'reports workspace metadata');
  assert.deepEqual(report, ['herdr', 'workspace', 'report-metadata', 'w9',
    '--source', 'plugin:tdi.worktree-from-linear', '--token', 'linear=BIT-1']);
  rmSync(dir, { recursive: true, force: true });
});

test('run still succeeds when the sidebar label cannot be reported', async () => {
  const dir = keyDir();
  const { exec: inner } = fakeExec();
  const exec = (cmd, args = []) => (args[0] === 'workspace'
    ? { status: 2, stdout: '', stderr: 'unrecognized subcommand\n' }
    : inner(cmd, args));
  const fetchFn = async () => ({ ok: true, status: 200, text: async () => SAMPLE });
  const warnings = [];
  const logs = [];
  const code = await run({ env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_WFP_CWD: '/repo' }, exec, fetchFn, select: async (l) => l[0], log: (m) => logs.push(m), warn: (m) => warnings.push(m) });
  assert.equal(code, 0);
  assert.match(warnings[0], /sidebar issue label failed/);
  assert.ok(logs.some((m) => /created worktree for BIT-1/.test(m)), 'still reports the worktree it made');
  rmSync(dir, { recursive: true, force: true });
});

test('cancelling the shared candidate picker never applies or delivers', async () => {
  const dir = keyDir(SLOT_CONFIG);
  const { exec, calls } = fakeExec();
  try {
    assert.equal(await run({ env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_WFP_CWD: '/repo' }, exec,
      fetchFn: async () => ({ ok: true, status: 200, text: async () => SAMPLE }),
      select: async (list) => ({ ...list[0], branchName: undefined }), selectWorktree: async () => null, log: () => {},
    }), 0);
    assert.ok(calls.some((c) => c[1] === 'plan-worktree'));
    assert.equal(calls.some((c) => c[1] === 'apply-worktree' || c[1] === 'pane' || c[1] === 'tab'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function runQuery(t, { query, row = '', config = {}, missing = false, list = true, cancel = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wfl-query-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    linearApiKeyEnvDefault: 'LIST_KEY', linearApiKeyEnvByTeam: { IC: 'IC_KEY', BIT: 'BIT_KEY' }, ...config,
  }));
  const calls = [];
  const fetches = [];
  const logs = [];
  const env = { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_WFP_CWD: '/repo', HERDR_WFP_MODE: 'start',
    HERDR_WFP_START_PANE: 'w1:p1', TASK_BIN: '/task', LIST_KEY: 'list-only', IC_KEY: 'ic-only', BIT_KEY: 'bit-only' };
  const code = await run({ env, log: (m) => logs.push(m), exec: (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git') return { status: 0, stdout: 'worktree /repo\nHEAD abc\n' };
    if (cmd === 'sh') return { status: 0 };
    if (cmd === 'fzf') return { status: cancel ? 130 : 0, stdout: `${query}\n${row}\n` };
    if (cmd === '/task') return { status: 0, stdout: 'Started' };
    assert.equal(cmd, 'herdr');
    assert.equal(args[0], 'notification');
    assert.ok(opts.timeout > 0);
    return { status: 0 };
  }, fetchFn: async (_url, opts) => {
    const body = JSON.parse(opts.body);
    fetches.push({ body, key: opts.headers.Authorization });
    if (body.variables.id) return { ok: true, text: async () => JSON.stringify(missing
      ? { errors: [{ message: 'Entity not found: Issue' }] }
      : { data: { issue: { identifier: body.variables.id, title: 'Found', branchName: 'found' } } }) };
    return { ok: true, text: async () => list ? SAMPLE : '{"data":{"issues":{"nodes":[]}}}' };
  } });
  return { code, calls, fetches, logs };
}

test('run loads a missing lowercase ID once with its team key', async (t) => {
  const result = await runQuery(t, { query: 'ic-1516', row: 'BIT-1 Do it' });
  assert.equal(result.code, 0);
  assert.deepEqual(result.fetches.map((request) => [request.body.variables.id, request.key]), [[undefined, 'list-only'], ['IC-1516', 'ic-only']]);
  assert.ok(result.calls.some((call) => call[0] === '/task' && call.includes('IC-1516 [M]')));
});

test('run uses a listed full ID before the highlighted row without lookup', async (t) => {
  const result = await runQuery(t, { query: 'bit-1', row: 'OTHER-2 Other' });
  assert.equal(result.code, 0);
  assert.equal(result.fetches.length, 1);
  assert.ok(result.calls.some((call) => call[0] === '/task' && call.includes('BIT-1 [M]')));
});

test('run handles each bare number rule', async (t) => {
  for (const [config, row, expected] of [
    [{ idTeamKey: 'IC', teamKey: 'BIT' }, '', 'IC-1516'],
    [{ teamKey: 'BIT' }, '', 'BIT-1516'], [{}, '', null],
    [{ idTeamKey: 'IC' }, 'BIT-1 Do it', 'BIT-1'],
  ]) {
    const result = await runQuery(t, { query: '1516', row, config });
    assert.equal(result.code, 0);
    const task = result.calls.find((call) => call[0] === '/task');
    assert.equal(task?.[2] ?? null, expected ? `${expected} [M]` : null);
    assert.equal(result.fetches.length, expected && expected !== 'BIT-1' ? 2 : 1);
  }
});

test('missing issues log and notify without a task or worktree', async (t) => {
  const result = await runQuery(t, { query: 'IC-1516', missing: true });
  assert.equal(result.code, 0);
  assert.deepEqual(result.logs, ['worktree-from-linear: issue IC-1516 not found']);
  assert.ok(result.calls.some((call) => call.includes('notification') && call.includes(result.logs[0])));
  assert.equal(result.calls.some((call) => call[0] === '/task' || call.includes('plan-worktree') || call.includes('apply-worktree')), false);
});

test('unknown team routing fails before an ID request', async (t) => {
  await assert.rejects(runQuery(t, { query: 'UNKNOWN-1' }), /configure issue team routing for UNKNOWN/);
});

test('empty lists still open the picker and can load an ID', async (t) => {
  const result = await runQuery(t, { query: 'IC-1516', list: false });
  assert.equal(result.code, 0);
  assert.equal(result.fetches.length, 2);
  assert.equal(result.logs[0], 'worktree-from-linear: no active issues');
  assert.ok(result.calls.some((call) => call[0] === 'fzf'));
});

test('Esc keeps the cancel result and skips lookup', async (t) => {
  const result = await runQuery(t, { query: 'IC-1516', cancel: true });
  assert.equal(result.code, 0);
  assert.deepEqual(result.logs, ['worktree-from-linear: cancelled']);
  assert.equal(result.fetches.length, 1);
});

async function showHere(t, { hostless = false } = {}) {
  const dir = keyDir({ ...SLOT_CONFIG, showIssueDetails: false, issueSlotSettleMs: 20, issueSlotPollMs: 20 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = await hostServer(t);
  const fake = slotExec({ paneTokens: hostTokens(host.socketPath), ...(hostless ? { processInfo: SHELL_FRONT } : {}) });
  const logs = [];
  const code = await run({ env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_WFP_CWD: '/repo',
    HERDR_WFP_MODE: 'show', HERDR_WFP_WORKSPACE: WS,
    HERDR_PLUGIN_CONTEXT_JSON: '{"workspace_id":"wrong","focused_pane_id":"wrong:p1"}' },
    exec: (cmd, args, opts) => {
      assert.equal(args.includes('plan-worktree') || args.includes('apply-worktree'), false);
      if (args[0] === 'workspace' && args[1] === 'get') {
        fake.calls.push([cmd, ...args]);
        assert.equal(args[2], WS);
        return { status: 0, stdout: WORKTREE_OUT };
      }
      return fake.exec(cmd, args, opts);
    }, fetchFn: async () => ({ ok: true, text: async () => SAMPLE }),
    select: async (issues) => issues[0],
    selectWorktree: () => assert.fail('show must not choose a worktree'), log: (m) => logs.push(m),
  });
  return { code, logs, calls: fake.calls, host };
}

test('show delivers to the invoking workspace with showIssueDetails false', async (t) => {
  const result = await showHere(t);
  assert.equal(result.code, 0, result.logs.join('\n'));
  assert.equal(result.host.seen.length, 1);
  assert.equal(result.host.seen[0].pane, SLOT);
  assert.equal(result.host.seen[0].issue, 'BIT-1');
  assert.ok(result.calls.some((call) => call[1] === 'workspace' && call[2] === 'get' && call[3] === WS));
});

test('show delivery failure logs, notifies and returns 1', async (t) => {
  const result = await showHere(t, { hostless: true });
  assert.equal(result.code, 1);
  assert.ok(result.logs.some((message) => /not delivered.*not running the issue host/.test(message)));
  assert.ok(result.calls.some((call) => call[1] === 'notification' && call.includes(result.logs[0])));
  assert.equal(result.host.seen.length, 0);
});

test('show rejects a missing or bad workspace before opening the picker', async () => {
  for (const workspace of [undefined, '', ' ', 'bad\nworkspace']) {
    await assert.rejects(run({ env: { HERDR_WFP_MODE: 'show', HERDR_WFP_WORKSPACE: workspace },
      exec: () => assert.fail('invalid workspace must not call native'),
      select: () => assert.fail('invalid workspace must not open picker'),
      fetchFn: () => assert.fail('invalid workspace must not fetch'),
    }), /valid invoking workspace ID/);
  }
  await assert.rejects(run({ env: { HERDR_WFP_MODE: 'show', HERDR_WFP_WORKSPACE: 'gone' },
    exec: () => ({ status: 1, stderr: 'workspace not found' }),
    select: () => assert.fail('missing workspace must not open picker'),
  }), /workspace not found/);
});

test('a mapped team works outside Git and normalizes a linked mapped checkout', async (t) => {
  const dir = keyDir({ repos: { BIT: '/mapped/linked' } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { exec: inner, calls } = fakeExec();
  const exec = (cmd, args, opts) => {
    if (cmd === 'git') {
      assert.ok(args.includes('--porcelain'));
      return args[1] === '/outside'
        ? { status: 1, stdout: '', stderr: 'not a repository' }
        : { status: 0, stdout: 'worktree /mapped/main\n\nworktree /mapped/linked\n', stderr: '' };
    }
    return inner(cmd, args, opts);
  };
  assert.equal(await run({ env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_WFP_CWD: '/outside' }, exec,
    fetchFn: async () => ({ ok: true, text: async () => SAMPLE }),
    select: async (issues) => issues[0], log: () => {},
  }), 0);
  const plan = calls.find((call) => call[1] === 'plan-worktree');
  assert.equal(plan[plan.indexOf('--cwd') + 1], '/mapped/main');
});

test('a bad mapped path never falls back to the invoking repository', async (t) => {
  const dir = keyDir({ repos: { BIT: 'relative/path' } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { exec, calls } = fakeExec();
  await assert.rejects(run({ env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_WFP_CWD: '/repo' }, exec,
    fetchFn: async () => ({ ok: true, text: async () => SAMPLE }),
    select: async (issues) => issues[0], log: () => {},
  }), /explicit invoking checkout/);
  assert.equal(calls.some((call) => call.includes('plan-worktree') || call.includes('apply-worktree')), false);
});

test('workspace issue metadata does not rename Crew labels or replace Crew tokens', async (t) => {
  const dir = keyDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { exec, calls } = fakeExec();
  await run({ env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_WFP_CWD: '/repo' }, exec,
    fetchFn: async () => ({ ok: true, text: async () => SAMPLE }),
    select: async (issues) => issues[0], log: () => {},
  });
  const reports = calls.filter((call) => call.includes('report-metadata'));
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0], ['herdr', 'workspace', 'report-metadata', 'w9',
    '--source', 'plugin:tdi.worktree-from-linear', '--token', 'linear=BIT-1']);
  assert.equal(calls.some((call) => call.includes('rename') || call.some((arg) => arg.startsWith('crew_'))), false);
});
