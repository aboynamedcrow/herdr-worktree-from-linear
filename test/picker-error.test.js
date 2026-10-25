import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pauseOnFailure } from '../lib/picker.js';

function fixture() {
  const input = new EventEmitter();
  const raw = [];
  let expired;
  let cleared = 0;
  let paused = 0;
  let resumed = 0;
  let printed = '';
  Object.assign(input, { isTTY: true, isRaw: false,
    setRawMode(value) { raw.push(value); },
    pause() { paused++; }, resume() { resumed++; },
  });
  const promise = pauseOnFailure({ input, output: { write(value) { printed += value; } },
    setTimer(callback, delay) { assert.equal(delay, 30000); expired = callback; return 42; },
    clearTimer(timer) { assert.equal(timer, 42); cleared++; },
  });
  return { input, promise, raw, expire: () => expired(),
    state: () => ({ cleared, paused, resumed, printed }) };
}

test('picker failure stays visible until a keypress and restores input', async () => {
  const f = fixture();
  assert.equal(f.input.listenerCount('data'), 1);
  assert.deepEqual(f.raw, [true]);
  f.input.emit('data', Buffer.from('r'));
  await f.promise;
  assert.deepEqual(f.raw, [true, false]);
  assert.deepEqual(f.state(), { cleared: 1, paused: 1, resumed: 1, printed: 'press any key to close\n' });
  assert.equal(f.input.listenerCount('data'), 0);
});

test('picker failure deadline removes the input listener', async () => {
  const f = fixture();
  f.expire();
  await f.promise;
  assert.equal(f.input.listenerCount('data'), 0);
  assert.deepEqual(f.raw, [true, false]);
  assert.equal(f.state().cleared, 1);
});

test('a pipe never waits for a picker close key', async () => {
  await pauseOnFailure({ input: { isTTY: false },
    output: { write() { assert.fail('no prompt'); } },
    setTimer() { assert.fail('no timer'); },
  });
});
