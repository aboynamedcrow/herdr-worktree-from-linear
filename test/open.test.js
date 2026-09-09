import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPicker } from '../lib/open.js';

function fixture(t, placement = 'overlay') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wfl-open-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ placement }));
  const context = { workspace_id: 'w1', focused_pane_id: 'w1:p1', focused_pane_cwd: dir };
  const env = { HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(context) };
  return { dir, context, env };
}

function openWith(f) {
  const calls = [];
  openPicker(f.env, (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (args[0] === 'pane' && args[1] === 'get') {
      return { status: 0, stdout: JSON.stringify({ result: { pane: { pane_id: 'w1:p1', workspace_id: 'w1', foreground_cwd: f.dir } } }) };
    }
    // `left`/`top` open a right/down split and then swap, which needs the
    // opened pane's id back from herdr.
    if (args[0] === 'plugin') {
      return { status: 0, stdout: JSON.stringify({ result: { plugin_pane: { pane: { pane_id: 'w1:p9' } } } }) };
    }
    return { status: 0, stdout: '{}' };
  });
  return calls;
}

test('the picker proves the original pane and preserves plugin executable cwd', (t) => {
  const f = fixture(t);
  const calls = openWith(f);
  assert.deepEqual(calls[0].args, ['pane', 'get', 'w1:p1']);
  const opened = calls[1];
  assert.ok(opened.args.includes(`HERDR_WFP_CWD=${f.dir}`));
  assert.equal(opened.args.includes('--cwd'), false);
  assert.equal(opened.args.includes('split'), false);
  assert.ok(calls.every((c) => c.opts.timeout > 0));
});

// herdr 0.9 refuses `--target-pane` for an overlay or popup plugin pane —
// `invalid_params: overlay and popup plugin panes target the active pane`, and
// no pane is created — so asking for one there breaks the whole action. The
// pane is still proved first, which is the guarantee that matters; only which
// pane native draws the overlay over stops being ours to choose.
test('a target pane is named only where the placement accepts one', (t) => {
  for (const placement of ['overlay', 'popup']) {
    const opened = openWith(fixture(t, placement))[1];
    assert.equal(opened.args.includes('--target-pane'), false, placement);
    assert.ok(opened.args.includes(placement), placement);
  }
  for (const placement of ['right', 'left', 'down', 'top']) {
    const opened = openWith(fixture(t, placement))[1];
    const at = opened.args.indexOf('--target-pane');
    assert.notEqual(at, -1, placement);
    assert.equal(opened.args[at + 1], 'w1:p1', placement);
  }
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
