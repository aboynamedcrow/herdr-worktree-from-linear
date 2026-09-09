import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../lib/run.js';
import { HOST_SCRIPT, checkoutDigest } from '../lib/hostwire.js';

const SAMPLE = JSON.stringify({ data: { issues: { nodes: [
  { identifier: 'BIT-1', title: 'Do it', branchName: 'tdi/bit-1-do-it', url: 'u', state: { name: 'Todo' }, assignee: { displayName: 'D' }, team: { key: 'BIT' } },
] } } });

function keyDir(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wfl-run-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ linearApiKey: 'k', ...config }));
  return dir;
}

function fakeExec() {
  const calls = [];
  const exec = (cmd, args = []) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git' && args.includes('--show-toplevel')) return { status: 0, stdout: '/repo\n', stderr: '' };
    if (cmd === 'git' && args.includes('symbolic-ref')) return { status: 0, stdout: 'origin/main\n', stderr: '' };
    if (cmd === 'git' && args.includes('list')) return { status: 0, stdout: 'worktree /repo\nbranch refs/heads/main\n', stderr: '' };
    if (cmd === 'git' && args.includes('rev-parse')) return { status: 1, stdout: '', stderr: '' };
    if (cmd === 'git' && args.includes('fetch')) return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'worktree') return { status: 0, stdout: '{"type":"worktree_created"}', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

test('run creates a worktree on the issue branch off origin/main', async () => {
  const dir = keyDir();
  const { exec, calls } = fakeExec();
  const fetchFn = async () => ({ ok: true, status: 200, text: async () => SAMPLE });
  const code = await run({ env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_WFP_CWD: '/repo', HERDR_BIN_PATH: 'herdr' }, exec, fetchFn, select: async (list) => list[0], log: () => {} });
  assert.equal(code, 0);
  assert.ok(calls.some((c) => c.includes('fetch') && c.includes('main')));
  assert.ok(calls.some((c) => c[0] === 'herdr' && c.includes('create') && c.includes('tdi/bit-1-do-it') && c.includes('--base') && c.includes('origin/main')));
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
    if (cmd === 'git' && args.includes('--show-toplevel')) {
      return { status: 0, stdout: '/repo/HSYS\n', stderr: '' };
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
  worktree: { path: CHECKOUT, label: 'bit-1', is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true },
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
    if (cmd === 'git' && args.includes('--show-toplevel')) return { status: 0, stdout: '/repo\n', stderr: '' };
    if (cmd === 'git' && args.includes('symbolic-ref')) return { status: 0, stdout: 'origin/main\n', stderr: '' };
    if (cmd === 'git' && args.includes('list')) {
      const porcelain = worktreeExists ? 'worktree /wt\nbranch refs/heads/tdi/bit-1-do-it\n' : 'worktree /repo\nbranch refs/heads/main\n';
      return { status: 0, stdout: porcelain, stderr: '' };
    }
    if (cmd === 'git' && args.includes('rev-parse')) return { status: 1, stdout: '', stderr: '' };
    if (cmd === 'git' && args.includes('fetch')) return { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'worktree') return { status: 0, stdout: WORKTREE_OUT, stderr: '' };
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
  for (const c of calls.filter((x) => x[2] === 'list')) assert.ok(c.includes(WS));
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
  assert.ok(calls.some((c) => c.includes('open')), 'precondition: this was the open path');
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
  // included: a server that accepts a command and never answers cannot hold the picker
  // open. (`worktree create|open` is deliberately not bounded here — it is the action the
  // user asked for, and it can legitimately take as long as a fetch and a checkout take.)
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
test('a repeat delivery focuses the live host over the socket herdr injected', async (t) => {
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
  assert.deepEqual(seen.map((r) => [r.method, r.params.pane_id]), [['pane.focus', SLOT]]);
  assert.equal(host.seen.length, 1, 'the host confirmed it before anything focused');
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
