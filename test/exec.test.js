import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd } from '../lib/exec.js';

test('runCmd returns status and stdout', () => {
  const res = runCmd('printf', ['hello']);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, 'hello');
});

test('runCmd reports non-zero status', () => {
  assert.equal(runCmd('sh', ['-c', 'exit 3']).status, 3);
});

// A command that never returns must not be able to hold a caller open: spawnSync enforces
// the bound itself, because a timer around a synchronous call cannot interrupt it.
test('runCmd kills a command that outlives its timeout, and says that is what happened', () => {
  const started = Date.now();
  const res = runCmd('sh', ['-c', 'exec sleep 30'], { timeout: 200 });
  assert.ok(Date.now() - started < 5000, 'it returned on the bound, not on the sleep');
  assert.equal(res.timedOut, true);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /timed out after 200ms/);
});

test('runCmd reports a command that cannot be spawned rather than throwing', () => {
  const res = runCmd('/nonexistent/herdr-that-is-not-there', ['pane', 'list']);
  assert.notEqual(res.status, 0);
  assert.equal(res.timedOut, false);
  assert.match(res.stderr, /ENOENT/);
});
