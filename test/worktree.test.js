import { test } from 'node:test';
import assert from 'node:assert/strict';
import { symlinkSync, unlinkSync } from 'node:fs';
import { discoverPlus, planIssueWorktree, applyIssueWorktree, readWorktreePlan } from '../lib/worktree.js';
import { plusFixture } from './support/plus-fixture.js';

const issue = { identifier: 'BIT-1', title: 'Do it', branchName: 'unrelated/provider-name' };
function setup(t, override = () => null) {
  const f = plusFixture();
  t.after(() => f.close());
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return override(cmd, args, opts) || f.reply(cmd, args, opts);
  };
  return { ...f, calls, exec };
}

test('shared backend uses its registered executable and its own configuration', (t) => {
  const f = setup(t);
  const planned = planIssueWorktree('/repo', issue, { env: { HERDR_PLUGIN_CONFIG_DIR: '/linear-config' }, exec: f.exec });
  const result = applyIssueWorktree(planned, planned.plan.candidates[0], f.exec);
  assert.equal(result.branchName, 'ingwon/bit-1-do-it');
  assert.equal(result.exists, false);
  const [plan, apply] = f.calls.filter((c) => c.cmd === f.binary);
  assert.equal(plan.opts.env.HERDR_PLUGIN_CONFIG_DIR, '/plus-config');
  assert.deepEqual(plan.args, ['plan-worktree', '--cwd', '/repo', '--name', 'Do it', '--issue', 'BIT-1']);
  assert.deepEqual(apply.args.slice(-4), ['--candidate', 'b'.repeat(64), '--fingerprint', 'a'.repeat(64)]);
  assert.ok(f.calls.every((c) => c.opts.timeout > 0));
  assert.equal(f.calls.some((c) => c.cmd === 'git' || c.args[0] === 'worktree'), false);
});

test('disabled, missing and ambiguous backend inventories refuse before planning', (t) => {
  const f = setup(t);
  for (const plugins of [[], [{ plugin_id: 'cloudmanic.herdr-plus', enabled: false, plugin_root: f.root }], [1, 2]]) {
    assert.throws(() => discoverPlus({}, () => ({ status: 0, stdout: JSON.stringify({ result: { plugins } }) })), /install and enable/);
  }
});

test('registered executable cannot escape plugin root through a symlink', (t) => {
  const f = setup(t);
  unlinkSync(f.binary);
  symlinkSync(process.execPath, f.binary);
  assert.throws(() => discoverPlus({}, f.exec), /outside its plugin/);
});

test('malformed or ambiguous choice ids are refused', (t) => {
  const f = setup(t);
  for (const plan of [{ ...f.plan, version: 2 }, { ...f.plan, fingerprint: '' },
    { ...f.plan, candidates: [] }, { ...f.plan, candidates: [f.plan.candidates[0], f.plan.candidates[0]] },
    { ...f.plan, candidates: [{ ...f.plan.candidates[0], path: 'relative' }] }]) {
    assert.throws(() => readWorktreePlan(JSON.stringify(plan)), /plan|choice/);
  }
});

test('unselected choice and stale apply never fall back to native creation or retry', (t) => {
  const f = setup(t, (_cmd, args) => args[0] === 'apply-worktree' ? { status: 1, stderr: 'worktree plan changed; refresh' } : null);
  const p = planIssueWorktree('/repo', issue, { env: {}, exec: f.exec });
  assert.throws(() => applyIssueWorktree(p, { id: 'c'.repeat(64) }, f.exec), /select a choice/);
  assert.equal(f.calls.some((c) => c.args[0] === 'apply-worktree'), false);
  assert.throws(() => applyIssueWorktree(p, p.plan.candidates[0], f.exec), /plan changed/);
  assert.equal(f.calls.filter((c) => c.args[0] === 'apply-worktree').length, 1);
});

test('apply validates checkout, branch and workspace attribution without retrying', (t) => {
  const f = setup(t);
  const p = planIssueWorktree('/repo', issue, { env: {}, exec: f.exec });
  for (const change of [
    (r) => { r.worktree.path = '/different'; },
    (r) => { r.worktree.branch = 'different'; },
    (r) => { r.root_pane = { workspace_id: 'wother' }; },
    (r) => { delete r.workspace.workspace_id; },
  ]) {
    const reply = JSON.parse(f.output); change(reply.result);
    let n = 0;
    assert.throws(() => applyIssueWorktree(p, p.plan.candidates[0], () => { n++; return { status: 0, stdout: JSON.stringify(reply) }; }), /another checkout|different or incomplete/);
    assert.equal(n, 1);
  }
});
