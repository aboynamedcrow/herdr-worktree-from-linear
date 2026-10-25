// The shared fetcher's lock under contention. Two hosts in one real temporary directory,
// a fake clock, and a Linear stand-in the test can hold open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSharedFetcher } from '../lib/fetcher.js';

function sharedDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wfl-fetcher-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const issueFor = (id, title) => ({ identifier: id, title, updatedAt: title });

// Linear below the wire. `hold()` keeps the next probe open until the test releases it.
function linearStub() {
  const log = [];
  let held = null;
  const titles = new Map();
  const probe = async (_config, ids) => {
    log.push(['probe', ids]);
    if (held) {
      const { promise } = held;
      held = null;
      return promise;
    }
    return new Map(ids.map((id) => [id, titles.get(id) ?? 'one']));
  };
  const fetchBatch = async (_config, ids) => {
    log.push(['full', ids]);
    return new Map(ids.map((id) => [id, issueFor(id, titles.get(id) ?? 'one')]));
  };
  return {
    probe, fetchBatch, log,
    set: (id, title) => titles.set(id, title),
    hold() {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      held = { promise };
      return { resolve, reject };
    },
  };
}

// A host polls every 2 s and its leader ticks every 10 s. Walk the clock there in ticks,
// so the heartbeat stays fresh the way it does in a running pane.
async function tickTo(fetcher, clock, time) {
  while (clock.time < time) {
    clock.time = Math.min(time, clock.time + 10000);
    await fetcher.step();
  }
}

function hostAt({ dir, pid, clock, live, linear, alive = (value) => live.has(value), wants = ['IC-1'] }) {
  const changes = [];
  const fetcher = createSharedFetcher({
    configDir: '/cfg', checkout: `/worktree-${pid}`, env: {}, dir, pid, instance: `i${pid}`,
    now: () => clock.time, alive, watch: () => null,
    load: () => ({ linearApiKey: 'secret' }), probe: linear.probe, fetchBatch: linear.fetchBatch,
    onChange: (snapshot) => changes.push(snapshot),
  });
  fetcher.setWants(new Map(wants.map((id) => [id, 300000])));
  return { fetcher, changes };
}

test('a leader displaced during a slow fetch writes neither the cache nor the lock, and follows', async (t) => {
  const dir = sharedDir(t);
  const clock = { time: 1000 };
  const live = new Set([11, 12]);
  const linear = linearStub();
  const a = hostAt({ dir, pid: 11, clock, live, linear });
  const b = hostAt({ dir, pid: 12, clock, live, linear });
  await a.fetcher.step();
  assert.equal(a.fetcher.role(), 'leader');
  assert.equal(readJson(join(dir, 'issues.json')).issues['IC-1'].issue.title, 'one');

  // A's next probe stalls, as across a laptop sleep. Its heartbeat ages past 90 s.
  const stalled = linear.hold();
  clock.time += 300000;
  const slowStep = a.fetcher.step();
  assert.deepEqual(linear.log.at(-1), ['probe', ['IC-1']]);

  // B finds the stale lock, takes it, and caches newer details.
  linear.set('IC-1', 'two');
  await b.fetcher.step();
  assert.equal(b.fetcher.role(), 'leader');
  assert.equal(readJson(join(dir, 'leader.json')).pid, 12);
  assert.equal(readJson(join(dir, 'issues.json')).issues['IC-1'].issue.title, 'two');
  const lockAfterB = readFileSync(join(dir, 'leader.json'), 'utf8');
  const cacheAfterB = readFileSync(join(dir, 'issues.json'), 'utf8');

  // A's request fails late. A has a change to record, but the lock is not its own.
  stalled.reject(new Error('aborted'));
  await slowStep;
  assert.equal(a.fetcher.role(), 'follower');
  assert.equal(readFileSync(join(dir, 'leader.json'), 'utf8'), lockAfterB, 'the lock still names B');
  assert.equal(readFileSync(join(dir, 'issues.json'), 'utf8'), cacheAfterB, 'the cache still holds B\'s details');
  assert.equal(readdirSync(dir).some((name) => name.endsWith('.tmp')), false);

  // As a follower, A reads B's cache instead.
  await a.fetcher.step();
  assert.equal(a.fetcher.snapshot().issues.get('IC-1').title, 'two');
  assert.equal(a.fetcher.snapshot().errors.has('IC-1'), false);
  assert.equal(b.fetcher.role(), 'leader');
  a.fetcher.close();
  b.fetcher.close();
  assert.deepEqual(readdirSync(dir), ['issues.json']);
});

test('a leader whose slow fetch succeeds inside its lease keeps the lock when nobody took it', async (t) => {
  const dir = sharedDir(t);
  const clock = { time: 1000 };
  const linear = linearStub();
  const a = hostAt({ dir, pid: 11, clock, live: new Set([11]), linear });
  await a.fetcher.step();
  // A leader renews its heartbeat on each tick, also when nothing is due.
  await tickTo(a.fetcher, clock, 291000);
  assert.equal(readJson(join(dir, 'leader.json')).beat, clock.time);
  assert.equal(linear.log.length, 2, 'nothing was due yet');
  const stalled = linear.hold();
  clock.time += 10000;
  const slowStep = a.fetcher.step();
  clock.time += 30000;
  stalled.resolve(new Map([['IC-1', 'one']]));
  await slowStep;
  assert.equal(a.fetcher.role(), 'leader');
  assert.equal(readJson(join(dir, 'leader.json')).beat, clock.time, 'the heartbeat is the time the step ended, not when it began');
});

test('a leader whose own lease ran out during the fetch writes nothing, then leads and writes on its next step', async (t) => {
  const dir = sharedDir(t);
  const clock = { time: 1000 };
  const linear = linearStub();
  const a = hostAt({ dir, pid: 11, clock, live: new Set([11]), linear });
  await a.fetcher.step();
  await tickTo(a.fetcher, clock, 291000);
  const lockBefore = readFileSync(join(dir, 'leader.json'), 'utf8');
  const cacheBefore = readFileSync(join(dir, 'issues.json'), 'utf8');
  assert.equal(JSON.parse(lockBefore).beat, 291000);
  assert.equal(JSON.parse(cacheBefore).issues['IC-1'].issue.title, 'one');
  assert.equal(linear.log.length, 2, 'nothing was due yet');

  // The fetch is due at five minutes and then spans 100 s: longer than the 90 s lease.
  // Nobody else is there to take the lock. The lock is still A's own, and stale.
  const stalled = linear.hold();
  clock.time += 10000;
  const slowStep = a.fetcher.step();
  linear.set('IC-1', 'two');
  clock.time += 100000;
  stalled.resolve(new Map([['IC-1', 'two']]));
  await slowStep;
  assert.deepEqual(linear.log.slice(2), [['probe', ['IC-1']], ['full', ['IC-1']]], 'the change was fetched');
  assert.equal(a.fetcher.role(), 'follower');
  assert.equal(readFileSync(join(dir, 'leader.json'), 'utf8'), lockBefore, 'no heartbeat');
  assert.equal(readFileSync(join(dir, 'issues.json'), 'utf8'), cacheBefore, 'no cache write');
  assert.equal(a.fetcher.snapshot().issues.get('IC-1').title, 'one', 'the unpublished result is given back');
  assert.equal(a.changes.length, 1, 'no change was announced');

  // The next step takes the stale lock again, fetches again, and writes.
  clock.time += 2000;
  await a.fetcher.step();
  assert.equal(a.fetcher.role(), 'leader');
  assert.deepEqual(linear.log.slice(4), [['probe', ['IC-1']], ['full', ['IC-1']]]);
  assert.equal(readJson(join(dir, 'leader.json')).pid, 11);
  assert.equal(readJson(join(dir, 'leader.json')).beat, clock.time);
  assert.equal(readJson(join(dir, 'issues.json')).issues['IC-1'].issue.title, 'two');
  assert.equal(a.fetcher.snapshot().issues.get('IC-1').title, 'two');
  assert.equal(a.changes.length, 2);
  assert.deepEqual(readdirSync(dir).sort(), ['host-11.json', 'issues.json', 'leader.json']);
});

test('two followers that read the same stale lock: the second keeps the fresh lock of the first', async (t) => {
  const dir = sharedDir(t);
  const clock = { time: 1000 };
  const live = new Set([11, 12, 13]);
  const linear = linearStub();
  const a = hostAt({ dir, pid: 11, clock, live, linear });
  await a.fetcher.step();
  assert.equal(a.fetcher.role(), 'leader');
  const b = hostAt({ dir, pid: 12, clock, live, linear });
  // C's liveness check of the old leader is the moment between its read of the stale lock
  // and its rename. B takes the lock exactly then. C's earlier decision must not move it.
  let interleaved = false;
  const c = hostAt({ dir, pid: 13, clock, live, linear, alive: (value) => {
    if (value === 11 && !interleaved) {
      interleaved = true;
      void b.fetcher.step();
    }
    return live.has(value);
  } });
  live.delete(11);
  clock.time += 100000;
  await c.fetcher.step();
  assert.equal(interleaved, true);
  assert.equal(b.fetcher.role(), 'leader');
  assert.equal(c.fetcher.role(), 'follower');
  assert.equal(readJson(join(dir, 'leader.json')).pid, 12, 'the fresh lock stayed where B put it');
  assert.equal(existsSync(join(dir, 'leader.json.13.stale')), false);
  await c.fetcher.step();
  assert.equal(c.fetcher.role(), 'follower');
  assert.equal(c.fetcher.snapshot().issues.get('IC-1').title, 'one');
});
