import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showArgs, showIssue } from '../lib/show.js';

const args = ['--workspace', 'w1', '--issue', 'IC-72'];
const reply = { workspace: { workspace_id: 'w1', worktree: { checkout_path: '/checkout' } } };
test('show accepts only one explicit workspace and issue', () => {
  assert.deepEqual(showArgs(args), { workspaceId: 'w1', identifier: 'IC-72' });
  for (const bad of [[], ['--issue', 'IC-72'], [...args, '--issue', 'IC-73'], ['--workspace', 'w1', '--issue', 'IC-0'], [...args, '--shell', 'sh']]) {
    assert.throws(() => showArgs(bad), /usage/);
  }
});
test('show uses only the exact native workspace checkout and configured host delivery', async () => {
  let n = 0;
  const code = await showIssue(args, { env: { LINEAR_API_KEY: 'test-only', HERDR_SOCKET_PATH: '/socket' },
    exec: (_cmd, actual, opts) => { n++; assert.deepEqual(actual, ['workspace', 'get', 'w1']); assert.ok(opts.timeout > 0); return { status: 0, stdout: JSON.stringify({ result: reply }) }; },
    deliver: async (request) => { assert.equal(request.identifier, 'IC-72'); assert.equal(request.socketPath, '/socket'); assert.deepEqual(JSON.parse(request.worktreeStdout).result, reply); return { ok: true }; },
  });
  assert.equal(code, 0); assert.equal(n, 1);
});
test('show refuses missing provenance, foreign workspace and failed host delivery', async () => {
  for (const result of [{ workspace: { workspace_id: 'w2', worktree: { checkout_path: '/checkout' } } }, { workspace: { workspace_id: 'w1' } }]) {
    await assert.rejects(showIssue(args, { env: {}, exec: () => ({ status: 0, stdout: JSON.stringify({ result }) }), deliver: () => assert.fail('no delivery') }), /identity changed|checkout path/);
  }
  await assert.rejects(showIssue(args, { env: { LINEAR_API_KEY: 'test-only' }, exec: () => ({ status: 0, stdout: JSON.stringify({ result: reply }) }), deliver: async () => ({ ok: false, error: 'host is busy' }) }), /host is busy/);
});
