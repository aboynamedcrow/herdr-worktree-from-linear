import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIssueIds } from '../lib/issue-list.js';
import { createListMode } from '../lib/list-mode.js';
import { createSharedFetcher } from '../lib/fetcher.js';
import { listKeyAction, openInLinear } from '../lib/list-keys.js';
import { formatIssueList } from '../lib/render.js';

const ids = ['IC-1', 'IC-2', 'HSYS-3', 'IC-4'];

function gitReader(values = {}) {
  const calls = [];
  const exec = (cmd, args, options) => {
    calls.push([cmd, ...args]);
    assert.equal(cmd, 'git');
    assert.deepEqual(args.slice(0, 4), ['-C', '/worktree', 'config', '--worktree']);
    assert.equal(args[4], args[5] === 'harkness.managed-issues' ? '--get' : '--get-all');
    assert.ok(['harkness.issues', 'harkness.managed-issues', 'harkness.tracker'].includes(args[5]));
    assert.ok(options.timeout > 0);
    const value = values[args[5]];
    if (value === undefined) return { status: 1, stdout: '' };
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    return { status: 0, stdout: `${Array.isArray(value) ? value.join('\n') : value}\n` };
  };
  return { calls, read: () => readIssueIds('/worktree', exec) };
}

test('the Git reader handles empty, tracker, four, duplicate, and invalid values', () => {
  assert.deepEqual(gitReader().read(), []);
  const legacy = gitReader({ 'harkness.tracker': ['IC-8'] });
  assert.deepEqual(legacy.read(), ['IC-8']);
  assert.deepEqual(legacy.calls.map((call) => call[6]),
    ['harkness.issues', 'harkness.managed-issues', 'harkness.tracker']);
  const four = gitReader({ 'harkness.issues': [...ids, 'IC-2', 'bad', 'IC-0', 'IC-5 extra'] });
  assert.deepEqual(four.read(), ids);
  assert.equal(four.calls.length, 1, 'a present list needs no extra Git call');
});

test('a managed empty list never reads the tracker', () => {
  const managed = gitReader({ 'harkness.managed-issues': 'true', 'harkness.tracker': ['IC-8'] });
  assert.deepEqual(managed.read(), []);
  assert.deepEqual(managed.calls.map((call) => call[6]), ['harkness.issues', 'harkness.managed-issues']);
});

test('a managed list keeps valid IDs without reading the managed key', () => {
  const managed = gitReader({ 'harkness.issues': ['bad', 'IC-2', 'IC-2'], 'harkness.managed-issues': 'true' });
  assert.deepEqual(managed.read(), ['IC-2']);
  assert.equal(managed.calls.length, 1);
});

test('other managed key values keep the tracker fallback', () => {
  for (const value of ['false', 'TRUE', '1', '', ' true', 'true ']) {
    const reader = gitReader({ 'harkness.managed-issues': value, 'harkness.tracker': ['IC-8'] });
    assert.deepEqual(reader.read(), ['IC-8'], value);
  }
});

test('a Git failure while reading the managed key throws', () => {
  const reader = gitReader({ 'harkness.managed-issues': { status: 2, stdout: '' }, 'harkness.tracker': ['IC-8'] });
  assert.throws(reader.read, /git config could not read harkness\.managed-issues/);
  assert.deepEqual(reader.calls.map((call) => call[6]), ['harkness.issues', 'harkness.managed-issues']);
});

// ---------------------------------------------------------------------------
// The list mode over the shared fetcher
//
// Linear is a fetch function that answers the real GraphQL bodies lib/linear.js builds:
// the `updatedAt` probe, the full batch, and the lookup by old id. Herdr is an exec that
// answers `pane get`. The clock and the shared directory are the test's own.

function linearFake(fixture, { fail = () => false } = {}) {
  const log = [];
  const fetchFn = async (_url, options) => {
    const body = JSON.parse(options.body);
    const auth = options.headers.Authorization;
    if (body.variables?.id) {
      log.push({ kind: 'byId', ids: [body.variables.id], auth });
      return { ok: true, status: 200, text: async () => JSON.stringify({ errors: [{ message: 'Entity not found: Issue' }], data: null }) };
    }
    const full = body.query.includes('description');
    const data = {};
    const ids = [];
    for (const match of body.query.matchAll(/i([0-9]+): issues\(first: 1, filter: \{ team: \{ key: \{ eq: "([A-Z0-9]+)" \} \}, number: \{ eq: ([0-9]+) \} \}\)/g)) {
      const id = `${match[2]}-${match[3]}`;
      ids.push(id);
      const issue = fixture[id];
      data[`i${match[1]}`] = { nodes: issue ? [full ? issue : { identifier: issue.identifier, updatedAt: issue.updatedAt }] : [] };
    }
    log.push({ kind: full ? 'full' : 'probe', ids, auth });
    const failure = fail();
    if (failure) throw new Error(failure);
    return { ok: true, status: 200, text: async () => JSON.stringify({ data }) };
  };
  return { fetchFn, log };
}

const fixtureFor = (list, updatedAt = '2026-10-24T10:00:00.000Z') => Object.fromEntries(list.map((id) => [id,
  { identifier: id, updatedAt, title: `Title ${id}`, state: { name: 'Todo', type: 'unstarted' }, url: `https://linear.app/a/issue/${id}` }]));

function herdrFake(focused = () => false) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    assert.deepEqual(args.slice(0, 2), ['pane', 'get']);
    return { status: 0, stdout: JSON.stringify({ result: { type: 'pane_info', pane: { pane_id: args[2], focused: focused() } } }), stderr: '' };
  };
  return { exec, calls };
}

function sharedDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wfl-list-shared-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// One host: a list mode over its own fetcher. `dir: null` is the private fetcher; a
// directory makes it one of the hosts that share it.
function host({ linear, clock, dir = null, pid = 11, live = new Set([11, 12]), initial = ids, herdr = herdrFake(),
  paneId = 'w9:p2', load = () => ({ linearApiKey: 'secret' }) } = {}) {
  let next = [...initial];
  let gitFailure = null;
  const views = [];
  const fetcher = createSharedFetcher({
    configDir: '/cfg', checkout: `/worktree-${pid}`, env: {}, dir, pid, instance: `i${pid}`,
    now: () => clock.time, alive: (value) => live.has(value), watch: () => null,
    fetchFn: linear.fetchFn, load,
  });
  const mode = createListMode({
    checkout: `/worktree-${pid}`, configDir: '/cfg', paneId, herdrBin: 'herdr', exec: herdr.exec,
    read: () => { if (gitFailure) throw new Error(gitFailure); return [...next]; },
    now: () => clock.time, fetcher, onUpdate: (view) => views.push(view),
  });
  return { mode, fetcher, views, herdr, setIds: (value) => { next = value; }, failGit: (message) => { gitFailure = message; } };
}

const clockAt = (time = 1000) => ({ time, advance(ms) { this.time += ms; } });
const requests = (log) => log.map((entry) => [entry.kind, entry.ids]);

test('a list change fetches the new ids, and a quiet list makes no request', async () => {
  const clock = clockAt();
  const linear = linearFake(fixtureFor([...ids, 'IC-5']));
  const h = host({ linear, clock });
  await h.mode.poll();
  assert.deepEqual(requests(linear.log), [['probe', ids], ['full', ids]], 'the probe runs first, then one full fetch');
  assert.equal(h.mode.view().issues.get('IC-2').title, 'Title IC-2');
  h.mode.select(1);
  assert.equal(h.mode.view().selected, 'IC-2');
  h.setIds([...ids, 'IC-5']);
  await h.mode.poll();
  assert.equal(h.mode.view().selected, 'IC-2');
  assert.deepEqual(requests(linear.log).slice(2), [['probe', ['IC-5']], ['full', ['IC-5']]], 'only the new id is fetched');
  h.setIds(['IC-1', 'HSYS-3', 'IC-4', 'IC-5']);
  await h.mode.poll();
  assert.equal(h.mode.view().selected, 'IC-1');
  assert.equal(linear.log.length, 4, 'a removed id costs nothing');
  const renders = h.views.length;
  clock.advance(2000);
  await h.mode.poll();
  assert.equal(h.views.length, renders, 'unchanged list does not redraw');
  assert.equal(linear.log.length, 4, 'nothing is due before its rate');
});

test('a background list probes every five minutes and fetches only a changed issue', async () => {
  const clock = clockAt();
  const fixture = fixtureFor(ids);
  const linear = linearFake(fixture);
  const h = host({ linear, clock });
  await h.mode.poll();
  assert.equal(linear.log.length, 2);
  clock.advance(60000);
  await h.mode.poll();
  assert.equal(linear.log.length, 2, 'an unfocused list is not fast');
  clock.advance(240000);
  await h.mode.poll();
  assert.deepEqual(requests(linear.log).slice(2), [['probe', ids]], 'the probe found no change, so no full fetch followed');
  const renders = h.views.length;
  fixture['HSYS-3'] = { ...fixture['HSYS-3'], updatedAt: '2026-10-24T11:00:00.000Z', title: 'Changed HSYS-3' };
  clock.advance(300000);
  await h.mode.poll();
  assert.deepEqual(requests(linear.log).slice(3), [['probe', ids], ['full', ['HSYS-3']]], 'only the changed id is fetched in full');
  assert.equal(h.mode.view().issues.get('HSYS-3').title, 'Changed HSYS-3');
  assert.equal(h.views.length, renders + 1, 'the change is drawn once');
});

test('a focused pane and an open full view are fast, and herdr is asked at most once per 10 s', async () => {
  const clock = clockAt();
  let focused = false;
  const herdr = herdrFake(() => focused);
  const linear = linearFake(fixtureFor(['IC-1', 'IC-2']));
  const h = host({ linear, clock, herdr, initial: ['IC-1', 'IC-2'] });
  await h.mode.poll();
  assert.equal(h.herdr.calls.length, 1);
  for (let i = 0; i < 4; i += 1) { clock.advance(2000); await h.mode.poll(); }
  assert.equal(h.herdr.calls.length, 1, 'four polls inside 10 s ask herdr nothing');
  clock.advance(2000);
  await h.mode.poll();
  assert.equal(h.herdr.calls.length, 2);
  assert.deepEqual(h.herdr.calls[1], ['herdr', 'pane', 'get', 'w9:p2']);
  // Focus arrives. The next herdr answer makes both ids fast.
  focused = true;
  clock.advance(10000);
  await h.mode.poll();
  assert.equal(linear.log.length, 2, 'focus alone fetches nothing');
  clock.advance(40000);
  await h.mode.poll();
  assert.deepEqual(requests(linear.log).slice(2), [['probe', ['IC-1', 'IC-2']]], 'a focused pane probes after 60 s');
  // Focus leaves, the full view opens on IC-2: only IC-2 stays fast.
  focused = false;
  await h.mode.setFull('IC-2');
  clock.advance(60000);
  await h.mode.poll();
  assert.deepEqual(requests(linear.log).slice(3), [['probe', ['IC-2']]]);
  await h.mode.setFull(null);
  clock.advance(60000);
  await h.mode.poll();
  assert.equal(linear.log.length, 4, 'a closed full view goes back to the slow rate');
});

test('r fetches now in the list and in the full view', async () => {
  const clock = clockAt();
  const fixture = fixtureFor(['IC-1']);
  const linear = linearFake(fixture);
  const h = host({ linear, clock, initial: ['IC-1'] });
  await h.mode.poll();
  assert.equal(linear.log.length, 2);
  clock.advance(1000);
  await h.mode.refresh();
  assert.deepEqual(requests(linear.log).slice(2), [['probe', ['IC-1']]], 'r probes at once, and an unchanged issue is not fetched again');
  await h.mode.setFull('IC-1');
  fixture['IC-1'] = { ...fixture['IC-1'], updatedAt: '2026-10-24T12:00:00.000Z', title: 'Fresh IC-1' };
  clock.advance(1000);
  await h.mode.refresh();
  assert.deepEqual(requests(linear.log).slice(3), [['probe', ['IC-1']], ['full', ['IC-1']]]);
  assert.equal(h.mode.view().issues.get('IC-1').title, 'Fresh IC-1');
});

test('selection stops at both ends and delivery lasts until the list changes', async () => {
  const clock = clockAt();
  const linear = linearFake(fixtureFor(['IC-1', 'IC-2', 'IC-9']));
  const h = host({ linear, clock, initial: ['IC-1', 'IC-2'] });
  await h.mode.poll();
  assert.equal(h.mode.select(-1), false);
  assert.equal(h.mode.select(1), true);
  assert.equal(h.mode.select(1), false);
  await h.mode.deliver('IC-9');
  assert.equal(h.mode.view().selected, 'IC-9');
  assert.equal(h.mode.view().override, 'IC-9');
  assert.equal(h.mode.view().issues.get('IC-9').title, 'Title IC-9', 'a delivered id is fetched through the same fetcher');
  assert.deepEqual(requests(linear.log).slice(2), [['probe', ['IC-9']], ['full', ['IC-9']]]);
  await h.mode.poll();
  assert.equal(h.mode.view().selected, 'IC-9');
  h.setIds(['IC-1', 'IC-2', 'IC-3']);
  await h.mode.poll();
  assert.equal(h.mode.view().selected, 'IC-1');
  assert.equal(h.mode.view().override, null);
});

test('a failed refresh keeps the last good issue data and shows one error without the key', async () => {
  const clock = clockAt();
  let failure = null;
  const linear = linearFake(fixtureFor(['IC-1']), { fail: () => failure });
  const h = host({ linear, clock, initial: ['IC-1'] });
  await h.mode.poll();
  failure = 'offline for secret';
  clock.advance(300000);
  await h.mode.poll();
  assert.equal(h.mode.view().issues.get('IC-1').title, 'Title IC-1');
  assert.match(h.mode.view().error, /^Linear: IC-1: offline for \[redacted\]$/);
  assert.equal(h.mode.view().error.includes('secret'), false);
  clock.advance(10000);
  await h.mode.poll();
  assert.equal(linear.log.length, 3, 'a failure is retried at the rate, not every tick');
  h.failGit('git config could not read harkness.issues');
  await h.mode.poll();
  assert.match(h.mode.view().error, /^Linear: /, 'a Linear problem stays in front of a Git one');
  failure = null;
  clock.advance(300000);
  await h.mode.poll();
  assert.match(h.mode.view().error, /^Git: git config could not read/);
});

test('mixed Linear credentials get one probe each, and one full fetch each', async () => {
  const clock = clockAt();
  const linear = linearFake(fixtureFor(['IC-1', 'HSYS-2', 'IC-3']));
  const load = (_dir, _cwd, _env, id) => ({ linearApiKey: id.startsWith('HSYS-') ? 'hsys-secret' : 'secret' });
  const h = host({ linear, clock, initial: ['IC-1', 'HSYS-2', 'IC-3'], load });
  await h.mode.poll();
  const byAuth = linear.log.map((entry) => [entry.kind, entry.auth, entry.ids]);
  assert.deepEqual(byAuth.filter(([kind]) => kind === 'probe'), [['probe', 'secret', ['IC-1', 'IC-3']], ['probe', 'hsys-secret', ['HSYS-2']]]);
  assert.deepEqual(byAuth.filter(([kind]) => kind === 'full'), [['full', 'secret', ['IC-1', 'IC-3']], ['full', 'hsys-secret', ['HSYS-2']]]);
  assert.equal(h.mode.view().issues.size, 3);
});

test('an id Linear does not know is looked up by old id once per rate, and reported', async () => {
  const clock = clockAt();
  const linear = linearFake(fixtureFor(['IC-1']));
  const h = host({ linear, clock, initial: ['IC-1', 'IC-7'] });
  await h.mode.poll();
  assert.deepEqual(requests(linear.log), [['probe', ['IC-1', 'IC-7']], ['byId', ['IC-7']], ['full', ['IC-1']]]);
  assert.equal(h.mode.view().error, 'Linear: IC-7: not found');
  clock.advance(10000);
  await h.mode.poll();
  assert.equal(linear.log.length, 3, 'a missing id is not asked for again before its rate');
});

test('two hosts in one shared directory produce one fetch stream, and no file holds a key', async (t) => {
  const dir = sharedDir(t);
  const clock = clockAt();
  const linear = linearFake(fixtureFor(['IC-1', 'IC-2', 'IC-3']));
  const a = host({ linear, clock, dir, pid: 11, initial: ['IC-1', 'IC-2'] });
  const b = host({ linear, clock, dir, pid: 12, initial: ['IC-2', 'IC-3'] });
  await a.mode.poll();
  assert.equal(a.fetcher.role(), 'leader');
  assert.deepEqual(requests(linear.log), [['probe', ['IC-1', 'IC-2']], ['full', ['IC-1', 'IC-2']]]);
  await b.mode.poll();
  assert.equal(b.fetcher.role(), 'follower');
  assert.equal(linear.log.length, 2, 'the follower fetches nothing itself');
  assert.equal(b.mode.view().issues.get('IC-2').title, 'Title IC-2', 'the follower renders from the cache');
  assert.equal(b.mode.view().issues.has('IC-3'), false, 'its own id waits for the leader');
  // The leader's next tick reads the follower's interest.
  clock.advance(10000);
  await a.mode.poll();
  assert.deepEqual(requests(linear.log).slice(2), [['probe', ['IC-3']], ['full', ['IC-3']]]);
  await b.mode.poll();
  assert.equal(b.mode.view().issues.get('IC-3').title, 'Title IC-3');
  // The follower's refresh reaches Linear through the leader, on its next tick.
  clock.advance(1000);
  await b.mode.refresh();
  assert.equal(linear.log.length, 4, 'the follower never calls Linear');
  clock.advance(10000);
  await a.mode.poll();
  assert.deepEqual(requests(linear.log).slice(4), [['probe', ['IC-2', 'IC-3']]], 'only the refreshing host\'s ids are probed');
  // Everything on disk, and nothing in it is a key.
  const names = readdirSync(dir).sort();
  assert.deepEqual(names, ['host-11.json', 'host-12.json', 'issues.json', 'leader.json']);
  for (const name of names) {
    const text = readFileSync(join(dir, name), 'utf8');
    assert.equal(text.includes('secret'), false, `${name} holds a key`);
  }
  const cache = JSON.parse(readFileSync(join(dir, 'issues.json'), 'utf8'));
  assert.deepEqual(Object.keys(cache.issues).sort(), ['IC-1', 'IC-2', 'IC-3']);
  assert.equal(cache.leader.pid, 11);
  const interest = JSON.parse(readFileSync(join(dir, 'host-12.json'), 'utf8'));
  assert.deepEqual(interest.wants, { 'IC-2': 300000, 'IC-3': 300000 });
  a.mode.close();
  b.mode.close();
  assert.deepEqual(readdirSync(dir), ['issues.json'], 'closing removes the lock and the interests, and keeps the cache');
});

test('the leader uses the rate each issue wants across hosts', async (t) => {
  const dir = sharedDir(t);
  const clock = clockAt();
  const linear = linearFake(fixtureFor(['IC-1', 'IC-2']));
  const focused = host({ linear, clock, dir, pid: 11, initial: ['IC-1'], herdr: herdrFake(() => true) });
  const background = host({ linear, clock, dir, pid: 12, initial: ['IC-2'] });
  // Both hosts poll, as they do every 2 s in a pane. A host that stops polling drops out.
  const pollBoth = async () => { await focused.mode.poll(); await background.mode.poll(); };
  await pollBoth();
  clock.advance(10000);
  await pollBoth();
  assert.deepEqual(requests(linear.log), [['probe', ['IC-1']], ['full', ['IC-1']], ['probe', ['IC-2']], ['full', ['IC-2']]]);
  clock.advance(50000);
  await pollBoth();
  assert.deepEqual(requests(linear.log).slice(4), [['probe', ['IC-1']]], 'the focused host\'s id is fast, the other is not');
  clock.advance(250000);
  await pollBoth();
  assert.deepEqual(requests(linear.log).slice(5), [['probe', ['IC-1', 'IC-2']]], 'both are due at five minutes');
  // The background host opens its full view: its id becomes fast in the leader.
  await background.mode.setFull('IC-2');
  clock.advance(60000);
  await pollBoth();
  assert.deepEqual(requests(linear.log).slice(6), [['probe', ['IC-1', 'IC-2']]]);
  // A host that stops polling is forgotten once its interest is older than five minutes.
  clock.advance(300001);
  await focused.mode.poll();
  assert.deepEqual(requests(linear.log).at(-1), ['probe', ['IC-1']]);
  assert.equal(existsSync(join(dir, 'host-12.json')), true, 'a live but silent host keeps its file');
});

test('a follower takes over when the leader exits, or when its process is gone', async (t) => {
  const dir = sharedDir(t);
  const clock = clockAt();
  const live = new Set([11, 12, 13]);
  const linear = linearFake(fixtureFor(['IC-1', 'IC-2', 'IC-3']));
  const a = host({ linear, clock, dir, pid: 11, live, initial: ['IC-1'] });
  const b = host({ linear, clock, dir, pid: 12, live, initial: ['IC-2'] });
  const c = host({ linear, clock, dir, pid: 13, live, initial: ['IC-3'] });
  await a.mode.poll();
  clock.advance(10000);
  await a.mode.poll();
  await b.mode.poll();
  await c.mode.poll();
  assert.deepEqual([a.fetcher.role(), b.fetcher.role(), c.fetcher.role()], ['leader', 'follower', 'follower']);
  // A clean exit releases the lock: the next follower to look takes it.
  a.mode.close();
  assert.equal(existsSync(join(dir, 'leader.json')), false);
  const before = linear.log.length;
  clock.advance(2000);
  await b.mode.poll();
  assert.equal(b.fetcher.role(), 'leader');
  assert.equal(JSON.parse(readFileSync(join(dir, 'leader.json'), 'utf8')).pid, 12);
  assert.ok(linear.log.length > before, 'the new leader fetches');
  await c.mode.poll();
  assert.equal(c.fetcher.role(), 'follower');
  // A killed leader leaves its lock behind. Its pid is gone, so the lock is stale.
  live.delete(12);
  clock.advance(2000);
  await c.mode.poll();
  assert.equal(c.fetcher.role(), 'leader');
  assert.equal(JSON.parse(readFileSync(join(dir, 'leader.json'), 'utf8')).pid, 13);
  assert.equal(c.mode.view().issues.get('IC-3').title, 'Title IC-3');
  // The dead host's interest is dropped: after its grace period, nothing probes IC-2.
  clock.advance(600000);
  await c.mode.poll();
  assert.deepEqual(requests(linear.log).at(-1), ['probe', ['IC-3']]);
  assert.equal(existsSync(join(dir, 'host-12.json')), false, 'the dead host\'s interest file is removed');
  // An old leader that is still alive, but silent for too long, is replaced as well.
  const d = host({ linear, clock, dir, pid: 14, live: new Set([13, 14]), initial: ['IC-1'] });
  clock.advance(90001);
  await d.mode.poll();
  assert.equal(d.fetcher.role(), 'leader');
  // And the replaced leader steps down when it sees the lock is not its own.
  await c.mode.poll();
  assert.equal(c.fetcher.role(), 'follower');
});

test('a host without a usable shared directory fetches on its own and says so', async (t) => {
  const dir = sharedDir(t);
  const clock = clockAt();
  const linear = linearFake(fixtureFor(['IC-1']));
  const fetcher = createSharedFetcher({
    configDir: '/cfg', checkout: '/worktree', env: {}, base: join(dir, 'missing', 'deeper'),
    pid: 11, instance: 'i11', now: () => clock.time, alive: () => true, watch: () => null,
    fetchFn: linear.fetchFn, load: () => ({ linearApiKey: 'secret' }),
  });
  assert.equal(fetcher.dir, null);
  assert.match(fetcher.note, /could not create/);
  const views = [];
  const mode = createListMode({ checkout: '/worktree', configDir: '/cfg', read: () => ['IC-1'], now: () => clock.time, fetcher, onUpdate: (view) => views.push(view) });
  await mode.poll();
  assert.equal(mode.view().issues.get('IC-1').title, 'Title IC-1');
  assert.match(mode.view().error, /^Fetcher: private, could not create/);
  assert.equal(mode.view().error.includes('secret'), false);
});

test('the list renders zero, one, and four issues with a marker and narrow title', () => {
  const empty = { ids: [], selected: null, issues: new Map(), error: '', override: null };
  assert.equal(formatIssueList(empty), '');
  const one = { ...empty, ids: ['IC-1'], selected: 'IC-1', issues: new Map([['IC-1', { identifier: 'IC-1', title: 'One', stateName: 'Todo' }]]) };
  assert.match(formatIssueList(one), /▸ IC-1  Todo  One/);
  assert.match(formatIssueList(one), /r refresh · q shell/);
  const many = { ...one, ids, issues: new Map(ids.map((id) => [id, { identifier: id, title: 'A title longer than this narrow pane', stateName: 'Todo' }])) };
  const list = formatIssueList(many, 28);
  assert.equal(list.split('\n').filter((row) => /IC-[124]|HSYS-3/.test(row)).length >= 4, true);
  assert.ok(list.split('\n')[0].length <= 26);
});

test('j, k, Enter, o, r, and q map to list actions', () => {
  assert.deepEqual([0x6a, 0x6b, 0x0d, 0x6f, 0x72, 0x71].map(listKeyAction),
    ['next', 'previous', 'full', 'open', 'refresh', 'quit']);
});

test('o opens only the selected Linear URL with a bounded native opener', () => {
  const calls = [];
  const run = (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; };
  assert.equal(openInLinear({ url: 'https://linear.app/rem-ember/issue/IC-1' }, { run, platform: 'darwin' }), true);
  assert.deepEqual(calls[0].args, ['https://linear.app/rem-ember/issue/IC-1']);
  assert.equal(calls[0].command, 'open');
  assert.equal(calls[0].options.timeout, 5000);
  assert.equal(openInLinear({ url: 'https://example.com/IC-1' }, { run }), false);
  assert.equal(calls.length, 1);
});
