// The `[[panes]]` issue entrypoint: a pane herdr opens and runs bin/issue.js in.
//
// Delivery into a pane of your own layout is a different thing entirely — an issue host
// you start yourself — and is covered in test/slot-host.test.js. What matters here is that
// this older entrypoint still works, still routes by issue team, and claims nothing: it
// owns no slot, publishes no identity, and makes no native call at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseViewerArgs } from '../bin/issue.js';
import { PTY_WRAPPER, ptyAvailable } from './pty.mjs';

// A stand-in for the herdr CLI that only records what it was asked to do. Every native
// call any entrypoint can make goes through HERDR_BIN_PATH, so an empty log proves none do.
function stubHerdr(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wfl-viewer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'herdr-stub');
  const log = join(dir, 'calls.log');
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`);
  chmodSync(bin, 0o755);
  return { dir, bin, log, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

// A fetch that answers only the workspace key it is told to expect, so a misrouted
// request comes back as "issue not found" instead of quietly succeeding.
function fakeApi(expected, identifier, title) {
  return `globalThis.fetch = async (_url, options) => ({
    ok: true,
    text: async () => JSON.stringify({ data: { issues: { nodes:
      options.headers.Authorization === ${JSON.stringify(expected)}
        ? [{ identifier: ${JSON.stringify(identifier)}, title: ${JSON.stringify(title)} }] : []
    } } })
  });`;
}

function runViewer({ args = [], env = {}, api, cwd }) {
  return spawnSync(process.execPath, [
    ...(api ? ['--import', `data:text/javascript,${encodeURIComponent(api)}`] : []),
    resolve('bin/issue.js'),
    ...args,
  ], { cwd, input: '', encoding: 'utf8', timeout: 10000, env: { ...process.env, ...env } });
}

function configDir(t, config) {
  const dir = mkdtempSync(join(tmpdir(), 'wfl-viewer-cfg-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return dir;
}

const TEAM_CONFIG = {
  linearApiKeyEnvByTeam: { HSYS: 'KEY_HSYS', IC: 'KEY_IC' },
  linearApiKeyEnvByPath: [{ contains: 'hsys', env: 'KEY_HSYS' }],
  linearApiKeyEnvDefault: 'KEY_IC',
};

test('parseViewerArgs prefers explicit flags and keeps the plugin-pane env form working', () => {
  const flags = parseViewerArgs(
    ['--issue', 'bit-7', '--config-dir', '/cfg', '--cwd', '/wt'],
    { HERDR_WFP_ISSUE: 'OLD-1', HERDR_PLUGIN_CONFIG_DIR: '/old' },
  );
  assert.deepEqual(flags, { identifier: 'BIT-7', configDir: '/cfg', cwd: '/wt' });
  // The [[panes]] "issue" entrypoint passes both through the environment.
  const fromEnv = parseViewerArgs([], { HERDR_WFP_ISSUE: ' hsys-4619 ', HERDR_PLUGIN_CONFIG_DIR: '/old' });
  assert.equal(fromEnv.identifier, 'HSYS-4619');
  assert.equal(fromEnv.configDir, '/old');
  // There is no pane or invocation to parse: this entrypoint owns no slot and publishes
  // no identity, so an inherited HERDR_PANE_ID cannot make it claim one.
  assert.deepEqual(Object.keys(parseViewerArgs([], { HERDR_PANE_ID: 'w9:p2' })).sort(), ['configDir', 'cwd', 'identifier']);
});

test('the issue pane routes by issue team for both workspaces', (t) => {
  const dir = configDir(t, TEAM_CONFIG);
  const env = { KEY_HSYS: 'synthetic-hsys', KEY_IC: 'synthetic-ic' };
  for (const [identifier, expected, title] of [
    ['HSYS-4619', 'synthetic-hsys', 'Routed HSYS fixture'],
    ['IC-72', 'synthetic-ic', 'Routed IC fixture'],
  ]) {
    // --cwd is the repository root loadConfig sees, so path routing cannot silently
    // decide the workspace from wherever the pane happened to start.
    const res = runViewer({
      args: ['--issue', identifier, '--config-dir', dir, '--cwd', '/repos/dot'],
      env,
      api: fakeApi(expected, identifier, title),
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, new RegExp(title));
    assert.doesNotMatch(res.stdout, /synthetic-hsys|synthetic-ic/);
    assert.doesNotMatch(res.stderr, /synthetic-hsys|synthetic-ic/);
  }
});

test('the issue pane makes no native call at all', (t) => {
  const stub = stubHerdr(t);
  const dir = configDir(t, TEAM_CONFIG);
  const res = runViewer({
    args: ['--issue', 'IC-72', '--config-dir', dir, '--cwd', '/repos/dot'],
    // HERDR_PANE_ID is set the way it is inside any managed pane, and is ignored.
    env: { KEY_IC: 'synthetic-ic', HERDR_BIN_PATH: stub.bin, HERDR_PANE_ID: 'w9:p2' },
    api: fakeApi('synthetic-ic', 'IC-72', 'Pane fixture'),
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(stub.calls(), [], 'it publishes nothing and asks herdr for nothing');
});

test('a failed fetch is rendered in the pane instead of taking it down', (t) => {
  const stub = stubHerdr(t);
  const dir = configDir(t, TEAM_CONFIG);
  const res = runViewer({
    args: ['--issue', 'IC-72', '--config-dir', dir, '--cwd', '/repos/dot'],
    env: { KEY_IC: 'synthetic-ic', HERDR_BIN_PATH: stub.bin },
    api: 'globalThis.fetch = async () => { throw new Error("network is down"); };',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Could not load IC-72: .*network is down/);
  assert.doesNotMatch(res.stdout, /synthetic-ic/);
  assert.deepEqual(stub.calls(), []);
});

test('a missing workspace key fails visibly without naming another workspace key', (t) => {
  const dir = configDir(t, TEAM_CONFIG);
  const res = runViewer({
    args: ['--issue', 'HSYS-4619', '--config-dir', dir, '--cwd', '/repos/dot'],
    env: { KEY_IC: 'synthetic-ic' },
    api: fakeApi('synthetic-hsys', 'HSYS-4619', 'never fetched'),
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /KEY_HSYS environment variable/);
  assert.doesNotMatch(res.stdout, /synthetic-ic/);
});

// ---------------------------------------------------------------------------
// Real terminal behavior
//
// Without a tty the pane's hold path is unobservable: stdin ends, the process falls off
// the end of the event loop, and every exit looks the same. This runs the real entrypoint
// under a real pty, so `hold()` actually holds.
// hold() hides the cursor on the way in and shows it again on exit, so those escapes are
// the observable difference between "held the pane" and "returned".
const HIDE_CURSOR = '\x1b[?25l';

test('on a real terminal the issue pane holds, and q closes it', (t) => {
  if (!ptyAvailable()) return t.skip('python3 pty module unavailable');
  const stub = stubHerdr(t);
  const dir = configDir(t, TEAM_CONFIG);
  // A plugin pane has no shell behind it: exiting would close the pane and take the
  // message with it, so it holds until the user closes it.
  const res = spawnSync('python3', ['-c', PTY_WRAPPER, process.execPath, resolve('bin/issue.js'),
    '--issue', 'IC-72', '--config-dir', dir, '--cwd', '/repos/dot'], {
    input: 'q', timeout: 10000, encoding: 'utf8',
    env: { ...process.env, HERDR_BIN_PATH: stub.bin, KEY_IC: '', KEY_HSYS: '' },
  });
  assert.equal(res.signal, null, 'q closed it rather than the timeout killing it');
  assert.equal(res.status, 0, res.stdout);
  assert.match(res.stdout, /Could not load IC-72/);
  assert.ok(res.stdout.includes(HIDE_CURSOR), 'it held the pane open');
  assert.deepEqual(stub.calls(), [], 'it owns no slot, so it publishes nothing');
});
