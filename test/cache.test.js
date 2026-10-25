import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { issueCache, cachedHeader, loadListConfig } from '../lib/cache.js';
import { select, formatLines, postAction } from '../lib/picker.js';
import { run } from '../lib/run.js';
import { plusFixture } from './support/plus-fixture.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const NOW = Date.parse('2026-10-24T12:00:00Z');
const OLD = { identifier: 'BIT-1', title: 'Old title', branchName: 'old', teamKey: 'BIT' };
const LIVE = { ...OLD, title: 'Live title', branchName: 'live' };
const node = (row) => ({ identifier: row.identifier, title: row.title, branchName: row.branchName, team: { key: row.teamKey } });
const reply = (data) => ({ ok: true, text: async () => JSON.stringify({ data }) });

function fixture(t, config = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wfl-cache-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ linearApiKeyEnvDefault: 'LIST_KEY', ...config }));
  const env = { HOME: home, HERDR_PLUGIN_CONFIG_DIR: home, HERDR_WFP_CWD: '/repo', LIST_KEY: 'synthetic-private-key', MATCH_KEY: 'other-synthetic-key',
    HERDR_WFP_MODE: 'start', HERDR_WFP_START_PANE: 'w1:p1', TASK_BIN: '/task' };
  const loaded = loadListConfig(home, '/repo', env);
  const cache = issueCache(loaded.config, { env, workspace: loaded.workspace, now: () => NOW });
  return { home, env, cache, ...loaded };
}

// A fake endpoint has the same key and lifetime gates as the real HTTP endpoint.
// The socket marker is a plain file. No fzf process or HTTP server runs here.
function fakeFzf(t, { query = 'title', selected = LIVE, status = 0 } = {}) {
  const started = deferred();
  const changed = deferred();
  let child, socket, key, open = false;
  const state = { requests: [], argv: [], initial: '', rows: '', header: '', query };
  const spawn = (cmd, args, opts) => {
    assert.equal(cmd, 'fzf');
    state.argv = args;
    socket = args.find((arg) => arg.startsWith('--listen=')).slice('--listen='.length);
    key = opts.env.FZF_API_KEY;
    assert.equal(statSync(dirname(socket)).mode & 0o777, 0o700);
    assert.ok(key);
    assert.equal(args.join(' ').includes(key), false);
    writeFileSync(socket, 'fake endpoint');
    open = true;
    state.header = args.find((arg) => arg.startsWith('--header=')).slice('--header='.length);
    child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stdin.on('data', (chunk) => { state.initial += chunk; state.rows += chunk; });
    child.stdin.on('finish', () => started.resolve());
    return child;
  };
  const sendAction = async (path, suppliedKey, body, isOpen) => {
    if (!open || !isOpen() || !existsSync(path)) throw new Error('closed endpoint');
    if (suppliedKey !== key) throw new Error('unauthorized');
    state.requests.push(body);
    if (body.startsWith('reload(')) {
      const pathMatch = /^reload\(cat '([^']+)'\)/.exec(body);
      assert.ok(pathMatch, body);
      state.rows = readFileSync(pathMatch[1], 'utf8');
      assert.equal(statSync(pathMatch[1]).mode & 0o777, 0o600);
    }
    state.header = /change-header\(([^)]*)\)$/.exec(body)?.[1] || state.header;
    changed.resolve();
  };
  const close = () => {
    open = false;
    child.stdout.end(`${state.query}\n${formatLines([selected])[0]}\n`);
    child.emit('close', status);
  };
  t.after(() => { if (open) close(); });
  return { spawn, sendAction, state, started: started.promise, changed: changed.promise, close,
    get socket() { return socket; }, get key() { return key; } };
}

function startRun(t, f, picker, fetchFn, extra = {}) {
  const calls = [];
  const logs = [];
  const backend = plusFixture();
  t.after(() => backend.close());
  const exec = (cmd, args = [], opts = {}) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git') return { status: 0, stdout: 'worktree /repo\nHEAD abc\n' };
    if (cmd === 'sh') return { status: 0 };
    if (cmd === '/task' || args[0] === 'notification' || args[1] === 'report-metadata') return { status: 0 };
    const result = backend.reply(cmd, args, opts);
    assert.ok(result, `unexpected ${cmd} ${args.join(' ')}`);
    return result;
  };
  const pending = run({ env: f.env, exec, fetchFn, now: () => NOW,
    pickerOptions: picker, log: (message) => logs.push(message), ...extra });
  return { pending, calls, logs };
}

test('cache hit opens cached rows before fetch completion and reloads once without changing the query', async (t) => {
  const f = fixture(t);
  f.cache.write([OLD]);
  const fetchDone = deferred();
  const picker = fakeFzf(t);
  let lists = 0;
  const ids = [];
  const job = startRun(t, f, picker, async (_url, opts) => {
    const body = JSON.parse(opts.body);
    assert.equal(opts.headers.Authorization, f.env.LIST_KEY);
    if (body.variables.id) { ids.push(body.variables.id); return reply({ issue: node(LIVE) }); }
    lists++;
    return fetchDone.promise;
  });
  await picker.started;
  assert.match(picker.state.initial, /Old title/);
  assert.equal(lists, 1);
  assert.equal(picker.state.header, 'cached 0m ago');
  fetchDone.resolve(reply({ issues: { nodes: [node(LIVE)] } }));
  await picker.changed;
  assert.match(picker.state.rows, /Live title/);
  assert.equal(picker.state.query, 'title');
  assert.equal(picker.state.header, 'live');
  assert.equal(picker.state.requests.length, 1);
  picker.close();
  assert.equal(await job.pending, 0);
  assert.deepEqual(ids, ['BIT-1']);
  assert.equal(f.cache.read().rows[0].title, LIVE.title);
  assert.equal(existsSync(dirname(picker.socket)), false);
  assert.equal(readdirSync(dirname(f.cache.path)).length, 1);
  for (const value of [readFileSync(f.cache.path, 'utf8'), JSON.stringify(picker.state.argv), readdirSync(dirname(f.cache.path)).join(' ')]) {
    assert.equal(value.includes(f.env.LIST_KEY), false);
    assert.equal(value.includes(picker.key), false);
  }
});

test('cache miss fetches once before fzf and writes a private file', async (t) => {
  const f = fixture(t);
  let fetches = 0;
  let opened = false;
  const code = await run({ env: f.env, now: () => NOW, log: () => {},
    fetchFn: async () => { assert.equal(opened, false); fetches++; return reply({ issues: { nodes: [node(LIVE)] } }); },
    exec: (cmd, args, opts) => {
      if (cmd === 'git') return { status: 0, stdout: 'worktree /repo\n' };
      if (cmd === 'sh') return { status: 0 };
      assert.equal(cmd, 'fzf');
      opened = true;
      assert.match(opts.input, /Live title/);
      assert.equal(args.some((arg) => arg.startsWith('--listen')), false);
      assert.ok(args.includes('--header=live'));
      return { status: 130 };
    } });
  assert.equal(code, 0);
  assert.equal(fetches, 1);
  assert.equal(opened, true);
  assert.equal(statSync(f.cache.path).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(f.cache.path)).mode & 0o777, 0o700);
});

test('failed refresh keeps cached rows and file and gives a short header error', async (t) => {
  const f = fixture(t);
  f.cache.write([OLD]);
  const before = readFileSync(f.cache.path, 'utf8');
  const fail = deferred();
  const picker = fakeFzf(t, { status: 130 });
  const job = startRun(t, f, picker, () => fail.promise);
  await picker.started;
  fail.reject(new Error(`network error ${f.env.LIST_KEY}`));
  await picker.changed;
  assert.equal(picker.state.header, 'cached 0m ago | refresh failed');
  assert.equal(picker.state.rows, picker.state.initial);
  assert.equal(picker.state.requests.some((body) => body.startsWith('reload(')), false);
  assert.equal(readFileSync(f.cache.path, 'utf8'), before);
  picker.close();
  assert.equal(await job.pending, 0);
});

test('cancel removes the endpoint before a late fetch writes the cache without a reload', async (t) => {
  const f = fixture(t);
  f.cache.write([OLD]);
  const fetched = deferred();
  const picker = fakeFzf(t, { status: 130 });
  const job = startRun(t, f, picker, () => fetched.promise);
  await picker.started;
  await assert.rejects(picker.sendAction(picker.socket, '', 'change-header(foreign)', () => true), /unauthorized/);
  picker.close();
  assert.equal(existsSync(picker.socket), false);
  await assert.rejects(picker.sendAction(picker.socket, picker.key, 'change-header(late)', () => true), /closed/);
  fetched.resolve(reply({ issues: { nodes: [node(LIVE)] } }));
  assert.equal(await job.pending, 0);
  assert.equal(picker.state.requests.length, 0);
  assert.equal(f.cache.read().rows[0].title, LIVE.title);
});

for (const [label, field, value] of [['team', 'teamKey', 'OTHER'], ['assignee', 'assignedToMe', true],
  ['triage', 'includeTriage', true], ['hours', 'recentDoneHours', 12], ['limit', 'issueLimit', 10]]) {
  test(`cache fingerprint mismatch for ${label} is a miss`, (t) => {
    const f = fixture(t);
    f.cache.write([OLD]);
    const other = issueCache({ ...f.config, [field]: value }, { env: f.env, workspace: f.workspace });
    assert.equal(other.read(), null);
  });
}

test('invalid JSON remains until the next fetch replaces it', (t) => {
  const f = fixture(t);
  f.cache.write([OLD]);
  writeFileSync(f.cache.path, '{bad');
  assert.equal(f.cache.read(), null);
  assert.equal(readFileSync(f.cache.path, 'utf8'), '{bad');
  f.cache.write([LIVE]);
  assert.equal(f.cache.read().rows[0].title, LIVE.title);
});

test('cache ages have no expiry and use stored fetch time with whole minutes', (t) => {
  const f = fixture(t);
  f.cache.write([OLD]);
  assert.equal(cachedHeader(f.cache.read().fetchedAt, () => NOW + 125999), 'cached 2m ago');
  assert.equal(cachedHeader(NOW + 1000, () => NOW), 'cached 0m ago');
  assert.equal(cachedHeader(null, () => NOW), 'refreshing');
  const data = JSON.parse(readFileSync(f.cache.path, 'utf8'));
  data.fetchedAt = 0;
  writeFileSync(f.cache.path, JSON.stringify(data));
  assert.equal(f.cache.read().fetchedAt, 0);
  data.fetchedAt = null;
  writeFileSync(f.cache.path, JSON.stringify(data));
  assert.equal(f.cache.read().fetchedAt, null);
});

test('workspace names follow config routing and inline keys use one fixed name', (t) => {
  const f = fixture(t, { linearApiKeyEnvByPath: [{ contains: 'Repo', env: 'MATCH_KEY' }] });
  const env = { ...f.env, MATCH_KEY: 'other-synthetic-key' };
  assert.equal(loadListConfig(f.home, '/REPO', env).workspace, 'MATCH_KEY');
  assert.equal(loadListConfig(f.home, '/elsewhere', env).workspace, 'LIST_KEY');
  writeFileSync(join(f.home, 'config.json'), JSON.stringify({ linearApiKey: 'inline-private-key' }));
  const loaded = loadListConfig(f.home, '/repo', env);
  assert.equal(loaded.workspace, 'inline');
  const cache = issueCache(loaded.config, { env, workspace: loaded.workspace });
  cache.write([{ ...OLD, linearApiKey: 'inline-private-key' }]);
  assert.equal(cache.path, join(f.home, '.cache', 'herdr-worktree-from-linear', 'inline.json'));
  assert.equal(readFileSync(cache.path, 'utf8').includes('inline-private-key'), false);
});

test('two cache writers replace one complete file and leave no temporary file', (t) => {
  const f = fixture(t);
  const other = issueCache(f.config, { env: f.env, workspace: f.workspace });
  f.cache.write([OLD]);
  other.write([LIVE]);
  assert.equal(f.cache.read().rows[0].title, LIVE.title);
  assert.deepEqual(readdirSync(dirname(f.cache.path)), ['LIST_KEY.json']);
  chmodSync(dirname(f.cache.path), 0o755);
  chmodSync(f.cache.path, 0o644);
  assert.ok(f.cache.read());
  assert.equal(statSync(dirname(f.cache.path)).mode & 0o777, 0o700);
  assert.equal(statSync(f.cache.path).mode & 0o777, 0o600);
});

for (const query of ['bit-1', '1']) {
  test(`query ${query} reads the selected cached issue fresh`, async (t) => {
    const f = fixture(t, { idTeamKey: 'IC' });
    f.cache.write([OLD]);
    const fetched = deferred();
    const picker = fakeFzf(t, { query, selected: OLD });
    const ids = [];
    const job = startRun(t, f, picker, async (_url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.variables.id) { ids.push(body.variables.id); return reply({ issue: node(LIVE) }); }
      return fetched.promise;
    });
    await picker.started;
    picker.close();
    fetched.resolve(reply({ issues: { nodes: [node(LIVE)] } }));
    assert.equal(await job.pending, 0);
    assert.deepEqual(ids, ['BIT-1']);
  });
}

test('typed full ID after reload still reads Linear once', async (t) => {
  const f = fixture(t);
  f.cache.write([OLD]);
  const fetched = deferred();
  const picker = fakeFzf(t, { query: 'BIT-1' });
  let reads = 0;
  const job = startRun(t, f, picker, async (_url, opts) => {
    if (JSON.parse(opts.body).variables.id) { reads++; return reply({ issue: node(LIVE) }); }
    return fetched.promise;
  });
  await picker.started;
  fetched.resolve(reply({ issues: { nodes: [node(LIVE)] } }));
  await picker.changed;
  picker.close();
  assert.equal(await job.pending, 0);
  assert.equal(reads, 1);
});

for (const mode of ['pick', 'start']) {
  test(`${mode} reads the selected cached issue fresh before the action`, async (t) => {
    const f = fixture(t);
    f.cache.write([OLD]);
    f.env.HERDR_WFP_MODE = mode;
    const picker = fakeFzf(t, { selected: OLD });
    const fetched = deferred();
    let reads = 0;
    const fresh = mode === 'start' ? { ...LIVE, identifier: 'NEW-1' } : LIVE;
    const job = startRun(t, f, picker, async (_url, opts) => {
      if (JSON.parse(opts.body).variables.id) { reads++; return reply({ issue: node(fresh) }); }
      return fetched.promise;
    });
    await picker.started;
    picker.close();
    fetched.resolve(reply({ issues: { nodes: [node(LIVE)] } }));
    assert.equal(await job.pending, 0);
    assert.equal(reads, 1);
    if (mode === 'pick') {
      const plan = job.calls.find((call) => call.includes('plan-worktree'));
      assert.equal(plan[plan.indexOf('--name') + 1], 'Live title');
      assert.equal(plan.includes('Old title'), false);
      assert.equal(plan.includes('old') || plan.includes('live'), false);
    } else assert.ok(job.calls.some((call) => call[0] === '/task' && call[2] === 'NEW-1 [M]'));
  });
  for (const failure of ['missing', 'error']) {
    test(`${mode} stops with status 1 and no action after a ${failure} fresh read`, async (t) => {
      const f = fixture(t);
      f.env.HERDR_WFP_MODE = mode;
      f.cache.write([OLD]);
      const fetched = deferred();
      const picker = fakeFzf(t, { selected: OLD });
      const job = startRun(t, f, picker, async (_url, opts) => {
        if (JSON.parse(opts.body).variables.id) {
          if (failure === 'error') throw new Error('fresh read failed');
          return reply({ issue: null });
        }
        return fetched.promise;
      });
      await picker.started;
      picker.close();
      fetched.resolve(reply({ issues: { nodes: [node(LIVE)] } }));
      assert.equal(await job.pending, 1);
      assert.equal(job.calls.some((call) => call.includes('plan-worktree') || call[0] === '/task'), false);
      assert.match(job.logs[0], failure === 'error' ? /fresh read failed/ : /not found/);
    });
  }
}

test('cache hit without fzf keeps the numbered prompt and refreshes disk', async (t) => {
  const f = fixture(t);
  f.cache.write([OLD]);
  const input = new PassThrough();
  const output = new PassThrough();
  const fetched = deferred();
  const pending = select(f.cache.read().rows, { exec: () => ({ status: 1 }), input, output,
    idTeamKey: 'BIT', header: 'cached 0m ago', refresh: async () => { const live = await fetched.promise; f.cache.write(live); return live; } });
  input.end('1\n');
  fetched.resolve([LIVE]);
  assert.equal((await pending).title, OLD.title);
  assert.equal(f.cache.read().rows[0].title, LIVE.title);
});

// This request fake checks the real sender's headers, startup retries, and errors.
// It does not create a network endpoint.
function fakeRequest(expectedKey, { ready = true, status = 200 } = {}) {
  const state = { ready, requests: [] };
  state.requestFn = (options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = (ms) => assert.equal(ms, 1000);
    req.end = (body) => {
      state.requests.push({ options, body });
      if (!state.ready) {
        req.emit('error', Object.assign(new Error('not listening'), { code: 'ENOENT' }));
        return;
      }
      const res = new EventEmitter();
      res.statusCode = options.headers['x-api-key'] === expectedKey ? status : 401;
      res.resume = () => {};
      callback(res);
      res.emit('end');
    };
    return req;
  };
  return state;
}

test('listen sender waits for startup and sends the key only in the HTTP header', async () => {
  const fake = fakeRequest('random-fzf-key', { ready: false });
  let waits = 0;
  await postAction('/private/f.sock', 'random-fzf-key', 'change-header(live)', () => true, {
    requestFn: fake.requestFn, wait: async () => { waits++; fake.ready = true; },
  });
  assert.equal(waits, 1);
  assert.equal(fake.requests.length, 2);
  assert.equal(fake.requests[1].options.headers['x-api-key'], 'random-fzf-key');
  assert.equal(fake.requests[1].body.includes('random-fzf-key'), false);
});

test('listen sender rejects unauthenticated and refused actions without retrying', async () => {
  for (const [supplied, status] of [['', 200], ['wrong', 200], ['key', 400]]) {
    const fake = fakeRequest('key', { status });
    await assert.rejects(postAction('/private/f.sock', supplied, 'reload(cat rows)', () => true, {
      requestFn: fake.requestFn, wait: () => assert.fail('HTTP errors must not retry'),
    }), /rejected/);
    assert.equal(fake.requests.length, 1);
  }
});

test('listen sender stops startup retries when fzf exits', async () => {
  const fake = fakeRequest('key', { ready: false });
  let open = true;
  await postAction('/private/f.sock', 'key', 'reload(cat rows)', () => open, {
    requestFn: fake.requestFn, wait: async () => { open = false; },
  });
  assert.equal(fake.requests.length, 1);
});

test('unknown cached age uses refreshing until a successful reload', async (t) => {
  const f = fixture(t);
  f.cache.write([OLD]);
  const data = JSON.parse(readFileSync(f.cache.path, 'utf8'));
  data.fetchedAt = null;
  writeFileSync(f.cache.path, JSON.stringify(data));
  const fetched = deferred();
  const picker = fakeFzf(t, { status: 130 });
  const job = startRun(t, f, picker, () => fetched.promise);
  await picker.started;
  assert.equal(picker.state.header, 'refreshing');
  fetched.resolve(reply({ issues: { nodes: [node(LIVE)] } }));
  await picker.changed;
  assert.equal(picker.state.header, 'live');
  picker.close();
  assert.equal(await job.pending, 0);
});


test('a failed cache write warns and keeps live rows usable', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.home, '.cache'), 'blocks the cache directory');
  const warnings = [];
  const cache = issueCache(f.config, { env: f.env, workspace: f.workspace, warn: (message) => warnings.push(message) });
  assert.equal(cache.read(), null);
  cache.write([LIVE]);
  assert.deepEqual(warnings, ['worktree-from-linear: could not write the issue cache']);
  assert.equal(readFileSync(join(f.home, '.cache'), 'utf8'), 'blocks the cache directory');
  const job = startRun(t, f, {}, async (_url, options) => JSON.parse(options.body).variables.id
    ? reply({ issue: node(LIVE) }) : reply({ issues: { nodes: [node(LIVE)] } }),
  { select: async (rows) => { assert.equal(rows[0].title, LIVE.title); return rows[0]; }, warn: () => {} });
  assert.equal(await job.pending, 0);
});

test('an absent HOME disables the cache without reading the real home', (t) => {
  const f = fixture(t);
  const cache = issueCache(f.config, { env: {}, workspace: f.workspace });
  assert.equal(cache.path, null);
  assert.equal(cache.read(), null);
  cache.write([LIVE]);
  assert.equal(existsSync(dirname(f.cache.path)), false);
});


for (const mode of ['pick', 'start']) {
  test(`${mode} reads a listed team absent from the team map with the list key`, async (t) => {
    const f = fixture(t, { linearApiKeyEnvByTeam: { IC: 'IC_KEY' }, idTeamKey: 'IC' });
    f.env.HERDR_WFP_MODE = mode;
    f.cache.write([OLD]);
    const fetched = deferred();
    const picker = fakeFzf(t, { query: '1', selected: OLD });
    const reads = [];
    const job = startRun(t, f, picker, async (_url, opts) => {
      const body = JSON.parse(opts.body);
      assert.equal(opts.headers.Authorization, f.env.LIST_KEY);
      if (body.variables.id) {
        reads.push(body.variables.id);
        return reply({ issue: node(LIVE) });
      }
      return fetched.promise;
    });
    await picker.started;
    picker.close();
    fetched.resolve(reply({ issues: { nodes: [node(LIVE)] } }));
    assert.equal(await job.pending, 0);
    assert.deepEqual(reads, ['BIT-1']);
    if (mode === 'pick') {
      const plan = job.calls.find((call) => call.includes('plan-worktree'));
      assert.ok(plan);
      assert.equal(plan[plan.indexOf('--name') + 1], LIVE.title);
      assert.equal(plan[plan.indexOf('--issue') + 1], LIVE.identifier);
    } else {
      assert.ok(job.calls.some((call) => call[0] === '/task' && call[2] === 'BIT-1 [M]'));
    }
  });

  test(`${mode} refuses a typed ID absent from the team map before an issue read`, async (t) => {
    const f = fixture(t, { linearApiKeyEnvByTeam: { IC: 'IC_KEY' } });
    f.env.HERDR_WFP_MODE = mode;
    f.cache.write([OLD]);
    const fetched = deferred();
    const picker = fakeFzf(t, { query: 'bit-1', selected: OLD });
    const job = startRun(t, f, picker, async (_url, opts) => {
      assert.equal(JSON.parse(opts.body).variables.id, undefined, 'the unmapped typed ID must fail before lookup');
      return fetched.promise;
    });
    await picker.started;
    picker.close();
    fetched.resolve(reply({ issues: { nodes: [node(LIVE)] } }));
    assert.equal(await job.pending, 1);
    assert.match(job.logs[0], /configure issue team routing for BIT/);
    assert.equal(job.calls.some((call) => call.includes('plan-worktree') || call[0] === '/task'), false);
  });
}
