import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../lib/run.js';

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
const WORKTREE_OUT = JSON.stringify({ result: {
  type: 'worktree_created',
  workspace: { workspace_id: WS, active_tab_id: TAB, label: 'BIT-1', number: 1, focused: true, pane_count: 2, tab_count: 1, agent_status: 'unknown' },
  tab: { tab_id: TAB, workspace_id: WS, label: 'Crew', number: 1, focused: true, pane_count: 2, agent_status: 'unknown' },
  root_pane: { pane_id: 'w9:p1', tab_id: TAB, workspace_id: WS, terminal_id: 't1', focused: true, agent_status: 'unknown', revision: 0, label: 'Orchestrator' },
  worktree: { path: '/wt/bit-1', label: 'bit-1', is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true },
} });
const SLOT_CONFIG = { showIssueDetails: true, issueTabLabel: 'Crew', issuePaneLabel: 'Issue / Utility', issueSlotSettleMs: 200, issueSlotPollMs: 200 };
const IDLE_SHELL = { pane_id: SLOT, shell_pid: 42, foreground_process_group_id: 42, foreground_processes: [{ pid: 42, name: 'zsh', argv0: 'zsh', argv: ['-zsh'] }] };
const BUSY_SHELL = { pane_id: SLOT, shell_pid: 42, foreground_process_group_id: 77, foreground_processes: [{ pid: 77, name: 'cat', argv0: 'cat', argv: ['cat'] }] };

// git answers plus a herdr that owns a laid-out Crew tab with one Issue / Utility slot.
function slotExec({ worktreeExists = false, processInfo = IDLE_SHELL } = {}) {
  const calls = [];
  const exec = (cmd, args = []) => {
    calls.push([cmd, ...args]);
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
    return { status: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

const paneRunOf = (calls) => calls.find((c) => c[1] === 'pane' && c[2] === 'run');

async function runWithSlot(dir, { exec, select = async (list) => list[0], log = () => {} } = {}) {
  return run({
    env: { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_WFP_CWD: '/repo', HERDR_BIN_PATH: 'herdr', HERDR_PLUGIN_ID: 'tdi.worktree-from-linear' },
    exec,
    fetchFn: async () => ({ ok: true, status: 200, text: async () => SAMPLE }),
    select,
    log,
  });
}

test('run delivers the issue viewer into the configured slot of the new workspace', async () => {
  const dir = keyDir(SLOT_CONFIG);
  const { exec, calls } = slotExec();
  assert.equal(await runWithSlot(dir, { exec }), 0);
  const sent = paneRunOf(calls);
  assert.ok(sent, 'the viewer command was typed into the slot');
  assert.equal(sent[3], SLOT);
  assert.match(sent[4], /'--issue' 'BIT-1'/);
  assert.match(sent[4], /bin\/issue\.js/);
  // The workspace id comes from the worktree reply, never from whoever has focus.
  for (const c of calls.filter((x) => x[2] === 'list')) assert.ok(c.includes(WS));
  assert.equal(calls.some((c) => c[2] === 'current'), false);
  rmSync(dir, { recursive: true, force: true });
});

// The old behavior skipped re-opens because it added a pane every time. Delivery targets
// a slot that is already there, so a re-open is exactly as valid as a fresh create.
test('run also delivers when an existing worktree is re-opened', async () => {
  const dir = keyDir(SLOT_CONFIG);
  const { exec, calls } = slotExec({ worktreeExists: true });
  assert.equal(await runWithSlot(dir, { exec }), 0);
  assert.ok(calls.some((c) => c.includes('open')), 'precondition: this was the open path');
  assert.ok(paneRunOf(calls), 'the viewer command was still delivered');
  rmSync(dir, { recursive: true, force: true });
});

test('run never splits, swaps, moves or resizes a pane to show the issue', async () => {
  const dir = keyDir(SLOT_CONFIG);
  const { exec, calls } = slotExec();
  assert.equal(await runWithSlot(dir, { exec }), 0);
  for (const c of calls) {
    for (const verb of ['split', 'swap', 'move', 'resize', 'zoom', 'close']) {
      assert.equal(c.includes(verb), false, `must not run: ${c.join(' ')}`);
    }
  }
  assert.equal(calls.some((c) => c[1] === 'plugin' && c[2] === 'pane'), false, 'no plugin pane is opened');
  rmSync(dir, { recursive: true, force: true });
});

// The worktree and its layout are already right; only the viewer failed to start.
test('a busy slot leaves the worktree alone and reports why nothing was delivered', async () => {
  const dir = keyDir(SLOT_CONFIG);
  const { exec, calls } = slotExec({ processInfo: BUSY_SHELL });
  const logs = [];
  assert.equal(await runWithSlot(dir, { exec, log: (m) => logs.push(m) }), 0);
  assert.ok(logs.some((m) => /created worktree for BIT-1/.test(m)), 'the worktree still succeeded');
  assert.ok(logs.some((m) => /issue details not delivered .*cat is running/.test(m)), 'and said why');
  assert.equal(paneRunOf(calls), undefined);
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
