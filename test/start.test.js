import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run } from '../lib/run.js';

const SAMPLE = JSON.stringify({ data: { issues: { nodes: [
  { identifier: 'IC-220', title: 'Start agent', state: { name: 'Todo' } },
] } } });
const MESSAGE = 'task new: IC-220 /worktree w2 w2:p1 test-account';
const STARTING = 'Starting IC-220 through task new. This can take minutes.';

// Run both CLI entry points. Herdr, Git, fzf, task, and Linear are fake.
function fixture(t, extraEnv = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wfl-start-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  mkdirSync(join(dir, 'dot', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ placement: 'right', showIssueDetails: true }));
  const script = `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const { basename } = require('node:path');
const args = process.argv.slice(2);
const command = basename(process.argv[1]);
const env = process.env;
const context = { HERDR_ENV: env.HERDR_ENV, HERDR_PANE_ID: env.HERDR_PANE_ID,
  HERDR_BIN_PATH: env.HERDR_BIN_PATH,
  HERDR_SOCKET_PATH: env.HERDR_SOCKET_PATH, TASK_LINEAR_KEY_ENV: env.TASK_LINEAR_KEY_ENV,
  LINEAR_API_KEY: env.LINEAR_API_KEY, KEEP_ME: env.KEEP_ME,
  pickerVariables: Object.keys(env).filter((name) => name.startsWith('HERDR_PLUGIN_') || name.startsWith('HERDR_WFP_')) };
appendFileSync(env.CALLS, JSON.stringify({ command, args, context }) + '\\n');
if (command === 'herdr') {
  if (args[0] === 'pane' && args[1] === 'get') {
    console.log(JSON.stringify({ result: { pane: {
      pane_id: 'w1:p1', workspace_id: 'w1', foreground_cwd: env.HOME,
    } } }));
  } else if (args[0] === 'plugin' && args[1] === 'pane') {
    console.log(JSON.stringify({ result: { plugin_pane: { pane: { pane_id: 'w1:p9' } } } }));
  } else if (args[0] !== 'notification') process.exit(99);
} else if (command === 'git') console.log(env.HOME);
else if (command === 'fzf') {
  if (env.CANCEL === '1') process.exit(130);
  console.log('IC-220  Start agent');
} else if (command === 'task') {
  if (env.TASK_STATUS === '2') {
    console.error('task new: refused: no room');
    process.exit(2);
  }
  console.log(${JSON.stringify(MESSAGE)});
} else process.exit(99);
`;
  for (const name of ['herdr', 'git', 'fzf', 'task']) {
    writeFileSync(join(bin, name), script, { mode: 0o700 });
  }
  writeFileSync(join(dir, 'dot', 'bin', 'task'), script, { mode: 0o700 });
  const env = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: dir, CALLS: join(dir, 'calls.jsonl'),
    HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_BIN_PATH: join(bin, 'herdr'),
    HERDR_PLUGIN_ROOT: dir, HERDR_PLUGIN_STATE_DIR: join(dir, 'state'),
    HERDR_PLUGIN_FUTURE: 'remove', HERDR_WFP_FUTURE: 'remove',
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: 'w1', focused_pane_id: 'w1:p1', focused_pane_cwd: dir }),
    HERDR_PANE_ID: 'w1:p99', HERDR_SOCKET_PATH: '/fake/herdr.sock',
    LINEAR_API_KEY: 'synthetic-key', TASK_LINEAR_KEY_ENV: 'LINEAR_API_KEY', KEEP_ME: 'preserved',
    TASK_BIN: join(bin, 'task'), ...extraEnv,
  };
  const invoke = (argv, overrides = {}) => spawnSync(process.execPath, argv, {
    env: { ...env, ...overrides }, encoding: 'utf8', input: '', timeout: 10000,
  });
  const calls = () => readFileSync(env.CALLS, 'utf8').trim().split('\n').map(JSON.parse);
  const manifest = readFileSync(resolve('herdr-plugin.toml'), 'utf8');
  const action = manifest.split('[[actions]]').find((entry) => /^id = "start"$/m.test(entry));
  assert.ok(action);
  assert.match(action, /^title = "Start agent on Linear issue"$/m);
  assert.match(action, /^contexts = \["workspace", "tab", "pane"\]$/m);
  const command = JSON.parse(/^command = (.+)$/m.exec(action)[1]);
  assert.deepEqual(command, ['node', 'bin/open.js', '--start']);
  const opened = invoke(command.slice(1));
  assert.equal(opened.status, 0, opened.stderr);
  const open = calls().find((call) => call.args[0] === 'plugin');
  const paneEnv = Object.fromEntries(open.args.flatMap((arg, i) => {
    if (open.args[i - 1] !== '--env') return [];
    const at = arg.indexOf('=');
    return [[arg.slice(0, at), arg.slice(at + 1)]];
  }));
  assert.equal(paneEnv.HERDR_WFP_MODE, 'start');
  assert.equal(paneEnv.HERDR_WFP_START_PANE, 'w1:p1');
  assert.equal(open.args.join(' ').includes('synthetic-key'), false);
  const picker = () => invoke([
    '--import', `data:text/javascript,${encodeURIComponent(`globalThis.fetch = async () => ({ ok: true, text: async () => ${JSON.stringify(SAMPLE)} });`)}`,
    resolve('bin/picker.js'),
  ], { ...paneEnv, HERDR_PANE_ID: 'w1:p9',
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: 'w1:p9' }) });
  return { env, calls, picker };
}

test('start action opens the picker and starts M from the invoking pane', (t) => {
  for (const defaultTask of [false, true]) {
    const f = fixture(t, defaultTask ? { TASK_BIN: '' } : {});
    const result = f.picker();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${STARTING}\n${MESSAGE}\n`);
    const calls = f.calls();
    const tasks = calls.filter((call) => call.command === 'task');
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0].args, ['new', 'IC-220 [M]']);
    assert.deepEqual(tasks[0].context, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1',
      HERDR_BIN_PATH: f.env.HERDR_BIN_PATH,
      HERDR_SOCKET_PATH: '/fake/herdr.sock', TASK_LINEAR_KEY_ENV: 'LINEAR_API_KEY',
      LINEAR_API_KEY: 'synthetic-key', KEEP_ME: 'preserved', pickerVariables: [] });
    assert.deepEqual(calls.filter((call) => call.command === 'herdr').map((call) => call.args.slice(0, 2)),
      [['pane', 'get'], ['plugin', 'pane'], ['notification', 'show']]);
    assert.ok(calls.some((call) => call.args.includes('--body') && call.args.includes(MESSAGE)));
  }
});

test('start cancellation runs no task or worktree command', (t) => {
  const f = fixture(t, { CANCEL: '1' });
  const before = f.calls().length;
  const result = f.picker();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cancelled/);
  assert.equal(result.stdout.includes(STARTING), false);
  assert.deepEqual(f.calls().slice(before).map((call) => call.command), ['git', 'fzf']);
});

test('task exit 2 prints its message, notifies, and makes the picker exit 1', (t) => {
  const f = fixture(t, { TASK_STATUS: '2' });
  const result = f.picker();
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, `${STARTING}\ntask new: refused: no room\n`);
  assert.ok(f.calls().some((call) => call.args.includes('task new: refused: no room')));
  assert.equal(f.calls().filter((call) => call.command === 'task').length, 1);
});

test('start strips picker variables, allows bootstrap time, and preserves stdout failures', async () => {
  const env = { HERDR_WFP_MODE: 'start', HERDR_WFP_CWD: '/repo', HOME: '/home/test',
    HERDR_WFP_START_PANE: 'w1:p1', HERDR_WFP_FUTURE: 'remove',
    HERDR_PLUGIN_ROOT: '/picker', HERDR_PLUGIN_STATE_DIR: '/picker-state', HERDR_PLUGIN_FUTURE: 'remove',
    HERDR_SOCKET_PATH: '/socket', HERDR_BIN_PATH: 'herdr', TASK_LINEAR_KEY_ENV: 'LINEAR_API_KEY',
    KEEP_ME: 'preserved', HERDR_PLUGIN: 'preserved', HERDR_WFP: 'preserved',
    LINEAR_API_KEY: 'synthetic-key', HERDR_PLUGIN_CONTEXT_JSON: '{"focused_pane_id":"w1:p9"}' };
  const logs = [];
  const code = await run({ env, select: async (issues) => issues[0],
    selectWorktree: () => assert.fail('no worktree choice'), log: (m) => logs.push(m),
    fetchFn: async () => ({ ok: true, text: async () => SAMPLE }),
    exec: (cmd, args, opts) => {
      if (cmd === 'git') return { status: 0, stdout: '/repo\n' };
      if (cmd === 'herdr') { assert.equal(args[0], 'notification'); return { status: 0 }; }
      assert.equal(cmd, '/home/test/dot/bin/task');
      assert.deepEqual(logs, [STARTING], 'progress must print before task starts');
      assert.deepEqual(opts.env, { HOME: '/home/test', HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1',
        HERDR_SOCKET_PATH: '/socket', HERDR_BIN_PATH: 'herdr', TASK_LINEAR_KEY_ENV: 'LINEAR_API_KEY',
        KEEP_ME: 'preserved', HERDR_PLUGIN: 'preserved', HERDR_WFP: 'preserved', LINEAR_API_KEY: 'synthetic-key' });
      assert.equal(opts.timeout, 3000000);
      return { status: 2, stdout: 'task new: refused: no room\n', stderr: '' };
    },
  });
  assert.equal(code, 1);
  assert.deepEqual(logs, [STARTING, 'task new: refused: no room']);
});

test('start refuses a missing captured pane despite the picker context', async () => {
  for (const paneId of [undefined, '', ' ']) {
    const logs = [];
    await assert.rejects(run({
      env: { HERDR_WFP_MODE: 'start', HERDR_WFP_CWD: '/repo', HERDR_WFP_START_PANE: paneId,
        LINEAR_API_KEY: 'synthetic-key', HERDR_PANE_ID: 'w1:p9',
        HERDR_PLUGIN_CONTEXT_JSON: '{"focused_pane_id":"w1:p9"}' },
      select: async (issues) => issues[0], log: (message) => logs.push(message),
      fetchFn: async () => ({ ok: true, text: async () => SAMPLE }),
      exec: (cmd, args) => {
        assert.equal(cmd, 'git', 'no task or worktree command may run');
        assert.deepEqual(args, ['-C', '/repo', 'rev-parse', '--show-toplevel']);
        return { status: 0, stdout: '/repo\n' };
      },
    }), /start requires the invoking pane context/);
    assert.deepEqual(logs, []);
  }
});
