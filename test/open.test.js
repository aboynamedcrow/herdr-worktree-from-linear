import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPicker } from '../lib/open.js';

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wfl-open-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ placement: 'overlay' }));
  const context = { workspace_id: 'w1', focused_pane_id: 'w1:p1', focused_pane_cwd: dir };
  const env = { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(context) };
  return { dir, context, env };
}

test('picker targets the original pane and preserves plugin executable cwd', (t) => {
  const f = fixture(t); const calls = [];
  openPicker(f.env, (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (args[0] === 'pane') return { status: 0, stdout: JSON.stringify({ result: { pane: { pane_id: 'w1:p1', workspace_id: 'w1', foreground_cwd: f.dir } } }) };
    return { status: 0, stdout: '{}' };
  });
  assert.deepEqual(calls[0].args, ['pane', 'get', 'w1:p1']);
  const opened = calls[1];
  assert.ok(opened.args.includes('--target-pane'));
  assert.ok(opened.args.includes('w1:p1'));
  assert.ok(opened.args.includes(`HERDR_WFP_CWD=${f.dir}`));
  assert.equal(opened.args.includes('--cwd'), false);
  assert.equal(opened.args.includes('split'), false);
  assert.ok(calls.every((c) => c.opts.timeout > 0));
});

test('missing and changed invocation contexts refuse without opening', (t) => {
  const f = fixture(t);
  assert.throws(() => openPicker({ PWD: f.dir }, () => assert.fail('no native lookup')), /context/);
  for (const pane of [
    { pane_id: 'w2:p1', workspace_id: 'w1', cwd: f.dir },
    { pane_id: 'w1:p1', workspace_id: 'w2', cwd: f.dir },
    { pane_id: 'w1:p1', workspace_id: 'w1', cwd: '/' },
  ]) {
    let n = 0;
    assert.throws(() => openPicker(f.env, () => { n++; return { status: 0, stdout: JSON.stringify({ result: { pane } }) }; }), /changed/);
    assert.equal(n, 1);
  }
});
