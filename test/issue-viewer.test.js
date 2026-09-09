import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseViewerArgs } from '../bin/issue.js';

// A stand-in for the herdr CLI that only records what it was asked to do. Every native
// call the viewer can make goes through HERDR_BIN_PATH, so this proves both that the
// expected calls happen and — where the log stays empty — that none do.
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
    ['--issue', 'bit-7', '--config-dir', '/cfg', '--cwd', '/wt', '--pane', 'w9:p2', '--invocation', 'inv0'],
    { HERDR_WFP_ISSUE: 'OLD-1', HERDR_PLUGIN_CONFIG_DIR: '/old' },
  );
  assert.deepEqual(flags, { identifier: 'BIT-7', configDir: '/cfg', cwd: '/wt', paneId: 'w9:p2', invocation: 'inv0' });
  // The [[panes]] "issue" entrypoint still passes both through the environment.
  const fromEnv = parseViewerArgs([], { HERDR_WFP_ISSUE: ' hsys-4619 ', HERDR_PLUGIN_CONFIG_DIR: '/old' });
  assert.equal(fromEnv.identifier, 'HSYS-4619');
  assert.equal(fromEnv.configDir, '/old');
  // Identity is only ever taken from argv. An inherited pane id would make a plain
  // `node bin/issue.js` publish tokens onto whichever pane the user happened to be in.
  assert.equal(parseViewerArgs([], { HERDR_PANE_ID: 'w9:p2', HERDR_WFP_ISSUE: 'BIT-1' }).paneId, null);
  assert.equal(parseViewerArgs(['--pane'], {}).paneId, null);
});

test('the launched viewer routes by issue team for both workspaces', (t) => {
  const dir = configDir(t, TEAM_CONFIG);
  const env = { KEY_HSYS: 'synthetic-hsys', KEY_IC: 'synthetic-ic' };
  for (const [identifier, expected, title] of [
    ['HSYS-4619', 'synthetic-hsys', 'Routed HSYS fixture'],
    ['IC-72', 'synthetic-ic', 'Routed IC fixture'],
  ]) {
    // --cwd is the repository root loadConfig sees, so path routing cannot silently
    // decide the workspace from wherever the shell happened to be.
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

test('a viewer given a pane publishes its identity and clears it on exit', (t) => {
  const stub = stubHerdr(t);
  const dir = configDir(t, TEAM_CONFIG);
  const res = runViewer({
    args: ['--issue', 'IC-72', '--config-dir', dir, '--cwd', '/repos/dot', '--pane', 'w9:p2', '--invocation', 'inv0'],
    env: { KEY_IC: 'synthetic-ic', HERDR_BIN_PATH: stub.bin },
    api: fakeApi('synthetic-ic', 'IC-72', 'Slot fixture'),
  });
  assert.equal(res.status, 0, res.stderr);
  const calls = stub.calls();
  assert.equal(calls.length, 2, calls.join(' | '));
  assert.equal(calls[0],
    'pane report-metadata w9:p2 --source tdi.worktree-from-linear --token wfl-issue=IC-72 --token wfl-invocation=inv0');
  // Exiting hands the pane back: the tokens a later delivery would read are removed.
  assert.equal(calls[1],
    'pane report-metadata w9:p2 --source tdi.worktree-from-linear --clear-token wfl-issue --clear-token wfl-invocation');
  // The key never reaches an argument list.
  assert.equal(calls.some((c) => c.includes('synthetic-ic')), false);
});

test('a viewer with no pane makes no native call at all', (t) => {
  const stub = stubHerdr(t);
  const dir = configDir(t, TEAM_CONFIG);
  const res = runViewer({
    args: ['--issue', 'IC-72', '--config-dir', dir, '--cwd', '/repos/dot'],
    // HERDR_PANE_ID is set the way it would be inside any managed pane, and is ignored.
    env: { KEY_IC: 'synthetic-ic', HERDR_BIN_PATH: stub.bin, HERDR_PANE_ID: 'w9:p2' },
    api: fakeApi('synthetic-ic', 'IC-72', 'Slot fixture'),
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(stub.calls(), []);
});

test('a failed fetch is shown in the slot instead of taking the viewer down', (t) => {
  const stub = stubHerdr(t);
  const dir = configDir(t, TEAM_CONFIG);
  const res = runViewer({
    args: ['--issue', 'IC-72', '--config-dir', dir, '--cwd', '/repos/dot', '--pane', 'w9:p2', '--invocation', 'inv0'],
    env: { KEY_IC: 'synthetic-ic', HERDR_BIN_PATH: stub.bin },
    api: 'globalThis.fetch = async () => { throw new Error("network is down"); };',
  });
  // Nothing about the worktree or the layout depends on the fetch succeeding, so the
  // viewer reports and holds rather than exiting non-zero into a bare prompt.
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Could not load IC-72: .*network is down/);
  assert.doesNotMatch(res.stdout, /synthetic-ic/);
  // It still owned the pane, so it still gives the tokens back.
  assert.equal(stub.calls().length, 2);
  assert.match(stub.calls()[1], /--clear-token wfl-issue --clear-token wfl-invocation/);
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
