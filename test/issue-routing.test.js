import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../lib/config.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wfl-issue-routing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    linearApiKeyEnvByTeam: { HSYS: 'KEY_HSYS', IC: 'KEY_IC' },
    linearApiKeyEnvByPath: [{ contains: 'hsys', env: 'KEY_HSYS' }],
    linearApiKeyEnvDefault: 'KEY_IC',
  }));
  return dir;
}

// Removing team routing must send HSYS to the wrong synthetic key and fail.
test('issue team selects its workspace even from another checkout', (t) => {
  const dir = fixture(t);
  const env = { KEY_HSYS: 'synthetic-hsys', KEY_IC: 'synthetic-ic' };
  assert.equal(loadConfig(dir, '/repos/dot', env, 'HSYS-4619').linearApiKey, env.KEY_HSYS);
  assert.equal(loadConfig(dir, '/repos/hsys', env, 'IC-72').linearApiKey, env.KEY_IC);
});

test('issue routing works outside a Git repository and normalizes team case', (t) => {
  const dir = fixture(t);
  assert.equal(loadConfig(dir, null, { KEY_HSYS: 'synthetic-hsys' }, ' hsys-4619 ').linearApiKey,
    'synthetic-hsys');
});

test('unknown or invalid issue team never falls back to another workspace', (t) => {
  const dir = fixture(t);
  for (const id of ['OTHER-1', 'HSYS-not-a-number']) {
    assert.throws(() => loadConfig(dir, '/repos/hsys', { KEY_IC: 'synthetic-ic' }, id),
      /issue.*routing|issue identifier/);
  }
});

test('a missing selected workspace key never falls back to the default key', (t) => {
  const dir = fixture(t);
  assert.throws(() => loadConfig(dir, '/repos/dot', { KEY_IC: 'synthetic-ic' }, 'HSYS-4619'),
    /KEY_HSYS environment variable/);
});

test('picker without an issue identifier retains repository routing', (t) => {
  const dir = fixture(t);
  assert.equal(loadConfig(dir, '/repos/hsys', { KEY_HSYS: 'synthetic-hsys' }).linearApiKey,
    'synthetic-hsys');
});

test('legacy inline key overrides a mapped team but not an unmapped team', (t) => {
  const dir = fixture(t);
  const configPath = join(dir, 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, linearApiKey: 'synthetic-inline' }));
  assert.equal(loadConfig(dir, '/repos/dot', {}, 'HSYS-4619').linearApiKey, 'synthetic-inline');
  assert.throws(() => loadConfig(dir, '/repos/dot', {}, 'OTHER-1'), /issue.*routing/);
});

test('real issue entrypoint routes by identifier before the external API boundary', (t) => {
  const dir = fixture(t);
  const fakeApi = `globalThis.fetch = async (_url, options) => ({
    ok: true,
    text: async () => JSON.stringify({data:{issues:{nodes:
      options.headers.Authorization === 'synthetic-hsys'
        ? [{identifier:'HSYS-4619',title:'Routed HSYS fixture'}] : []
    }}})
  });`;
  const result = spawnSync(process.execPath, [
    '--import', 'data:text/javascript,' + encodeURIComponent(fakeApi),
    resolve('bin/issue.js'),
  ], {
    cwd: dir, input: '', encoding: 'utf8', timeout: 5000,
    env: { ...process.env, HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_WFP_ISSUE: 'HSYS-4619',
      KEY_HSYS: 'synthetic-hsys', KEY_IC: 'synthetic-ic' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Routed HSYS fixture/);
  assert.doesNotMatch(result.stdout, /synthetic-hsys|synthetic-ic/);
  assert.doesNotMatch(result.stderr, /synthetic-hsys|synthetic-ic/);
});
