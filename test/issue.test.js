import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hold, renderWithGlow } from '../bin/issue.js';

// hold() runs again after every re-render. Wiring a listener pair per call would cross
// Node's 11-listener threshold and print MaxListenersExceededWarning to stderr — into the
// rendered pane. stdin is not a tty under the test runner, which is also the no-tty path.
test('hold does not accumulate listeners across re-renders', (t) => {
  // hold() resumes stdin; leave it paused however this test ends, or the runner hangs.
  t.after(() => process.stdin.pause());
  const exitBefore = process.listenerCount('exit');
  const dataBefore = process.stdin.listenerCount('data');
  for (let i = 0; i < 15; i++) hold();
  assert.equal(process.listenerCount('exit') - exitBefore, 1, 'exactly one exit listener');
  assert.equal(process.stdin.listenerCount('data') - dataBefore, 0, 'no data listener without a tty');
  assert.ok(process.listenerCount('exit') < process.getMaxListeners(), 'stays under the warning threshold');
});

// glow is optional: the pane must fall back rather than depend on it. stdout is a pipe
// under the test runner, which is the same gate a missing glow hits.
test('renderWithGlow declines when stdout is not a tty, so the caller falls back', () => {
  assert.equal(process.stdout.isTTY, undefined, 'precondition: stdout is not a tty here');
  assert.equal(renderWithGlow('# md', 'plain'), false);
});
