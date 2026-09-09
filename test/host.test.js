import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSocketHome, publishHost, hostMetadataArgs, hostMetadataClearArgs, judgeRequest, resolveHostContext,
  startHost,
} from '../lib/host.js';
import {
  HOST_PROTOCOL, MAX_FRAME_BYTES, askHost, buildShowRequest, checkoutDigest, takeFrame,
} from '../lib/hostwire.js';
import { main as hostMain } from '../bin/slot-host.js';

const PANE = 'w9:p2';

function tempDir(t, prefix = 'wfl-host-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function configDir(t) {
  const dir = tempDir(t, 'wfl-host-cfg-');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ linearApiKey: 'synthetic-key' }));
  return dir;
}

// One Linear-shaped answer, and a record of every request that was made. The key never
// leaves the process it was loaded in, so a fetch that carries it is a test failure.
function fakeLinear(title = 'Host fixture') {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, auth: options.headers.Authorization, signal: options.signal });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: { issues: { nodes: [{ identifier: 'IC-72', title }] } } }),
    };
  };
  return { fetchFn, calls };
}

// A real host on a real temporary unix socket, with the terminal replaced by two
// recorders: nothing in these tests renders.
async function liveHost(t, over = {}) {
  const shown = [];
  const failed = [];
  const started = await startHost({
    paneId: PANE,
    configDir: configDir(t),
    checkout: '/wt/ic-72',
    pid: 4242,
    instance: 'instance-token-0',
    onShow: (issue) => shown.push(issue),
    onFail: (identifier, reason) => failed.push({ identifier, reason }),
    connectionIdleMs: 250,
    ...over,
  });
  assert.equal(started.ok, true, started.error);
  t.after(() => started.host.close());
  return { host: started.host, shown, failed };
}

const expectationFor = (request) => ({
  id: request.id,
  pane: request.pane,
  host: request.host,
  pid: request.pid,
  checkout: request.checkout,
  issue: request.issue,
});

async function show(host, issue, over = {}) {
  const request = buildShowRequest({
    issue, pane: host.paneId, host: host.instance, pid: host.pid, checkout: host.checkout, ...over,
  });
  return { request, reply: await askHost(host.socketPath, request, expectationFor(request), { timeoutMs: 2000 }) };
}

// Wait for a condition the host reaches asynchronously, without sleeping for a fixed time.
async function until(predicate, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// Context

test('a host refuses to run without knowing exactly which pane it is in', () => {
  // No --pane, and no HERDR_PANE_ID: there is deliberately no "the focused pane" fallback,
  // because the focused pane belongs to whoever last clicked.
  const noPane = resolveHostContext(['--config-dir', '/cfg'], {}, '/wt');
  assert.equal(noPane.ok, false);
  assert.match(noPane.error, /--pane/);
  assert.equal(resolveHostContext([], { HERDR_FOCUSED_PANE: PANE, HERDR_PLUGIN_CONFIG_DIR: '/cfg' }, '/wt').ok, false);
  // A pane id that could be read as a flag or a path is not a pane id.
  assert.equal(resolveHostContext(['--pane', '--cwd'], { HERDR_PLUGIN_CONFIG_DIR: '/cfg' }, '/wt').ok, false);
  assert.equal(resolveHostContext(['--pane', PANE, '--config-dir', 'relative'], {}, '/wt').ok, false);
});

test('a host takes its identity from flags, then from its own pane environment', (t) => {
  const dir = tempDir(t);
  const flags = resolveHostContext(['--pane', PANE, '--config-dir', '/cfg', '--cwd', dir], {
    HERDR_PANE_ID: 'other:pane', HERDR_PLUGIN_CONFIG_DIR: '/other',
  });
  assert.equal(flags.ok, true, flags.error);
  assert.equal(flags.paneId, PANE);
  assert.equal(flags.configDir, '/cfg');
  // The checkout is canonical on both sides, so the picker's path and the host's path are
  // comparable rather than two spellings of the same directory.
  assert.equal(flags.checkout, realpathSync(dir));

  const fromEnv = resolveHostContext([], { HERDR_PANE_ID: PANE, HERDR_PLUGIN_CONFIG_DIR: '/cfg' }, dir);
  assert.equal(fromEnv.ok, true, fromEnv.error);
  assert.equal(fromEnv.paneId, PANE);
  assert.equal(fromEnv.configDir, '/cfg');

  // A checkout that is not there cannot be canonicalized, and is refused rather than
  // published as something the picker will then fail to match.
  assert.equal(resolveHostContext(['--pane', PANE, '--config-dir', '/cfg', '--cwd', join(dir, 'gone')], {}).ok, false);
});

// ---------------------------------------------------------------------------
// The socket and its directory

test('the socket lives in an owner-only directory, at a path nothing else holds', (t) => {
  const base = tempDir(t);
  const home = createSocketHome({ base });
  assert.equal(home.ok, true, home.error);
  t.after(() => rmSync(home.dir, { recursive: true, force: true }));
  const dir = lstatSync(home.dir);
  assert.equal(dir.isDirectory(), true);
  assert.equal(dir.uid, process.getuid());
  assert.equal(dir.mode & 0o077, 0, 'no group or other access');
  assert.equal(home.socketPath.startsWith(`${home.dir}/`), true);
  assert.equal(existsSync(home.socketPath), false, 'the path is unused until the host binds it');
  // Two homes never collide, so one host cannot be handed another's socket path.
  const second = createSocketHome({ base });
  assert.notEqual(second.dir, home.dir);
  rmSync(second.dir, { recursive: true, force: true });
});

test('a socket path something already holds is refused rather than bound', (t) => {
  const base = tempDir(t);
  // mkdtemp normally hands back an empty directory it just made. Hand back one that is
  // not empty instead: a leftover file, or a symlink pointing somewhere else, must stop
  // the host rather than be bound over.
  for (const plant of [
    (dir) => writeFileSync(join(dir, 's'), 'not a socket'),
    (dir) => symlinkSync('/etc/passwd', join(dir, 's')),
  ]) {
    const home = createSocketHome({
      base,
      mkdtemp: (prefix) => { const dir = mkdtempSync(prefix); plant(dir); return dir; },
    });
    assert.equal(home.ok, false);
    assert.match(home.error, /something is already there/);
  }
});

test('closing a host removes exactly its own socket and directory', async (t) => {
  const { host } = await liveHost(t);
  assert.equal(lstatSync(host.socketPath).isSocket(), true);
  assert.equal((lstatSync(host.socketPath).mode & 0o077), 0, 'the socket itself is owner-only too');
  const neighbour = join(host.dir, 'not-ours');
  writeFileSync(neighbour, 'x');
  host.close();
  assert.equal(existsSync(host.socketPath), false, 'its socket is gone');
  // A directory that still holds something nobody asked it to delete is left alone.
  assert.equal(existsSync(neighbour), true, 'nothing else was deleted');
  rmSync(host.dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The request state machine, without a socket

const SELF = { paneId: PANE, instance: 'i0', pid: 4242, checkout: '/wt/ic-72' };
const idle = () => ({ issue: null, phase: 'idle' });
const request = (over = {}) => ({
  protocol: HOST_PROTOCOL, id: 'n0', op: 'show', issue: 'IC-72',
  pane: PANE, host: 'i0', pid: 4242, checkout: '/wt/ic-72', ...over,
});

test('a request is refused unless it names this exact host', () => {
  assert.equal(judgeRequest(request(), SELF, idle()).status, 'accepted');
  for (const [field, value] of [
    ['protocol', 'wfl-host-0'], ['op', 'run'], ['id', ''], ['pane', 'w9:p3'],
    ['host', 'i1'], ['pid', 4243], ['checkout', '/wt/other'], ['issue', 'not an issue'],
  ]) {
    const verdict = judgeRequest(request({ [field]: value }), SELF, idle());
    assert.equal(verdict.status, 'refused', `${field}=${value} must be refused`);
  }
  assert.equal(judgeRequest(null, SELF, idle()).status, 'refused');
  assert.equal(judgeRequest([], SELF, idle()).status, 'refused');
  // There is exactly one operation, and it names an issue. Nothing in the shape of a
  // request can ask the host to run, spawn, read or write anything.
  assert.deepEqual(Object.keys(request()).sort(), ['checkout', 'host', 'id', 'issue', 'op', 'pane', 'pid', 'protocol']);
});

test('the same issue is reused; a different one is busy, never a takeover', () => {
  const showing = { issue: 'IC-72', phase: 'showing' };
  assert.equal(judgeRequest(request(), SELF, showing).status, 'showing');
  assert.equal(judgeRequest(request({ issue: 'IC-73' }), SELF, showing).status, 'busy');
  // Still fetching counts as taken: a second issue must not start a second fetch.
  const fetching = { issue: 'IC-72', phase: 'fetching' };
  assert.equal(judgeRequest(request(), SELF, fetching).status, 'showing');
  assert.equal(judgeRequest(request({ issue: 'IC-73' }), SELF, fetching).status, 'busy');
});

// ---------------------------------------------------------------------------
// The host over a real socket

test('a host shows the issue a request names, and fetches it exactly once', async (t) => {
  const linear = fakeLinear('Real socket fixture');
  const { host, shown } = await liveHost(t, { fetchFn: linear.fetchFn });
  const { reply } = await show(host, 'IC-72');
  assert.deepEqual({ ok: reply.ok, status: reply.status, issue: reply.issue }, { ok: true, status: 'accepted', issue: 'IC-72' });
  assert.equal(await until(() => shown.length === 1), true, 'the issue reached the terminal callback');
  assert.equal(shown[0].title, 'Real socket fixture');
  assert.equal(linear.calls.length, 1);
  // The request contributed an identifier. The key came from config, in this process.
  assert.equal(linear.calls[0].auth, 'synthetic-key');
});

test('a repeat request for the same issue is reused, and starts no second fetch', async (t) => {
  const linear = fakeLinear();
  const { host, shown } = await liveHost(t, { fetchFn: linear.fetchFn });
  await show(host, 'IC-72');
  assert.equal(await until(() => shown.length === 1), true);
  const { reply } = await show(host, 'IC-72');
  assert.equal(reply.ok, true);
  assert.equal(reply.status, 'showing', 'the picker focuses this pane instead of restarting anything');
  assert.equal(linear.calls.length, 1);
  assert.equal(shown.length, 1, 'what is on screen was not re-rendered');
});

test('a different issue is refused as busy, and the shown one is left alone', async (t) => {
  const linear = fakeLinear();
  const { host, shown } = await liveHost(t, { fetchFn: linear.fetchFn });
  await show(host, 'IC-72');
  assert.equal(await until(() => shown.length === 1), true);
  const { reply } = await show(host, 'IC-99');
  assert.equal(reply.ok, false);
  assert.match(reply.error, /busy: showing IC-72/);
  assert.equal(linear.calls.length, 1, 'no second fetch');
  assert.equal(host.state().issue, 'IC-72');
});

test('two requests in flight cannot start two fetches', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const fetchFn = async (_url, options) => {
    calls.push(options.headers.Authorization);
    await gate;
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { issues: { nodes: [{ identifier: 'IC-72' }] } } }) };
  };
  const { host, shown } = await liveHost(t, { fetchFn });
  // Both are sent before either can be answered, so the second one lands while the first
  // fetch is still in flight — the case where a check-then-act host would race itself.
  const [first, second] = await Promise.all([show(host, 'IC-72'), show(host, 'IC-99')]);
  assert.equal(first.reply.ok, true);
  assert.equal(first.reply.status, 'accepted');
  assert.equal(second.reply.ok, false);
  assert.match(second.reply.error, /busy/);
  assert.equal(calls.length, 1, 'busy was set before the first fetch started, not after it finished');
  release();
  assert.equal(await until(() => shown.length === 1), true);
  assert.equal(calls.length, 1);
});

test('malformed, oversized and misdirected frames are refused without side effects', async (t) => {
  const linear = fakeLinear();
  const { host, shown } = await liveHost(t, { fetchFn: linear.fetchFn });
  const raw = async (payload) => {
    const { connect } = await import('node:net');
    return new Promise((resolve) => {
      const socket = connect(host.socketPath);
      let buffer = '';
      const done = (value) => { try { socket.destroy(); } catch { /* gone */ } resolve(value); };
      socket.setEncoding('utf8');
      socket.on('error', (err) => done({ error: err.message }));
      socket.on('close', () => done({ closed: true, buffer }));
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.includes('\n')) done(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))));
      });
      socket.on('connect', () => socket.write(payload));
    });
  };
  const valid = buildShowRequest({
    issue: 'IC-72', pane: host.paneId, host: host.instance, pid: host.pid, checkout: host.checkout,
  });
  assert.equal((await raw('not json at all\n')).status, 'refused');
  assert.equal((await raw(`${JSON.stringify({ protocol: HOST_PROTOCOL, id: 'n', op: 'exec', issue: 'IC-72' })}\n`)).status, 'refused');
  // A frame that never ends is answered at a fixed size, not buffered.
  const unterminated = await raw('x'.repeat(MAX_FRAME_BYTES + 64));
  assert.equal(unterminated.status, 'refused');
  assert.match(unterminated.detail, /oversized/);
  // And so is one that arrives complete: a newline does not buy a frame more room. Both
  // the plain and the multibyte form are over the cap in bytes; the multibyte one is
  // under it in JavaScript string length, which is exactly why the cap counts bytes.
  const overByChars = `${'x'.repeat(MAX_FRAME_BYTES + 64)}\n`;
  const overByBytes = `${'\u20ac'.repeat(Math.ceil(MAX_FRAME_BYTES / 3) + 1)}\n`;
  assert.ok(overByBytes.length < MAX_FRAME_BYTES, 'precondition: it is short as a string');
  assert.ok(Buffer.byteLength(overByBytes, 'utf8') > MAX_FRAME_BYTES, 'precondition: and long as bytes');
  for (const payload of [overByChars, overByBytes]) {
    const answer = await raw(payload);
    assert.equal(answer.status, 'refused');
    assert.match(answer.detail, /oversized/);
  }
  // One connection carries one frame. A valid request with anything after it is refused
  // rather than half-honored.
  const trailing = await raw(`${JSON.stringify(valid)}\n${JSON.stringify(valid)}\n`);
  assert.equal(trailing.status, 'refused');
  assert.match(trailing.detail, /more than one request/);

  assert.equal(host.state().issue, null);
  assert.equal(linear.calls.length, 0);
  assert.equal(shown.length, 0);
});

test('the frame cap counts bytes, and one connection carries one frame', () => {
  assert.deepEqual(takeFrame('{"a":1}\n'), { state: 'frame', frame: '{"a":1}' });
  assert.deepEqual(takeFrame('{"a":1}'), { state: 'incomplete' });
  assert.deepEqual(takeFrame(''), { state: 'incomplete' });
  // Unterminated and terminated are capped identically.
  assert.deepEqual(takeFrame('x'.repeat(MAX_FRAME_BYTES + 1)), { state: 'oversized' });
  assert.deepEqual(takeFrame(`${'x'.repeat(MAX_FRAME_BYTES + 1)}\n`), { state: 'oversized' });
  // Multibyte UTF-8: short in string length, over the cap in bytes, with and without the
  // terminating newline.
  const euros = '\u20ac'.repeat(Math.ceil(MAX_FRAME_BYTES / 3) + 1);
  assert.ok(euros.length < MAX_FRAME_BYTES && Buffer.byteLength(euros, 'utf8') > MAX_FRAME_BYTES);
  assert.deepEqual(takeFrame(euros), { state: 'oversized' });
  assert.deepEqual(takeFrame(`${euros}\n`), { state: 'oversized' });
  // Exactly at the cap is still a frame, in either encoding.
  assert.deepEqual(takeFrame(`${'x'.repeat(MAX_FRAME_BYTES)}\n`).state, 'frame');
  const exact = `${'\u20ac'.repeat(Math.floor(MAX_FRAME_BYTES / 3))}${'x'.repeat(MAX_FRAME_BYTES % 3)}`;
  assert.equal(Buffer.byteLength(exact, 'utf8'), MAX_FRAME_BYTES);
  assert.deepEqual(takeFrame(`${exact}\n`).state, 'frame');
  // Anything after the newline is a second frame nobody asked for.
  assert.deepEqual(takeFrame('{"a":1}\n{"b":2}\n'), { state: 'trailing' });
  assert.deepEqual(takeFrame('{"a":1}\n '), { state: 'trailing' });
});

test('a reply is capped and single-framed the same way a request is', async (t) => {
  // The same gap on the other side of the wire: a host that answers with one enormous
  // newline-terminated line, or with more than one reply, must not be parsed.
  const { createServer } = await import('node:net');
  const answer = async (payload) => {
    const dir = mkdtempSync(join(tmpdir(), 'wfl-reply-'));
    const socketPath = join(dir, 'r.sock');
    const server = createServer((conn) => { conn.end(payload); });
    await new Promise((resolve) => server.listen(socketPath, resolve));
    try {
      const request = buildShowRequest({ issue: 'IC-72', pane: PANE, host: 'i0', pid: 1, checkout: '/wt' });
      return await askHost(socketPath, request, expectationFor(request), { timeoutMs: 2000 });
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const padded = (extra) => {
    const request = buildShowRequest({ issue: 'IC-72', pane: PANE, host: 'i0', pid: 1, checkout: '/wt', id: 'x' });
    return { protocol: HOST_PROTOCOL, id: request.id, ok: true, status: 'accepted', pane: PANE, host: 'i0', pid: 1, checkout: '/wt', issue: 'IC-72', detail: extra };
  };
  for (const payload of [
    `${'y'.repeat(MAX_FRAME_BYTES + 1)}\n`,
    `${'\u20ac'.repeat(Math.ceil(MAX_FRAME_BYTES / 3) + 1)}\n`,
    `${JSON.stringify(padded('z'.repeat(MAX_FRAME_BYTES)))}\n`,
  ]) {
    const res = await answer(payload);
    assert.equal(res.ok, false);
    assert.match(res.error, /oversized/);
  }
  const twice = await answer('{"a":1}\n{"a":2}\n');
  assert.equal(twice.ok, false);
  assert.match(twice.error, /more than one reply/);
  // A well-formed single frame still gets through, so the cap is not simply rejecting
  // everything.
  const good = await answer(`${JSON.stringify(padded('ok'))}\n`);
  assert.equal(good.ok, false, 'this fixture answers a different request id');
  assert.match(good.error, /replied to/);
});

test('a client that connects and says nothing is dropped, not held', async (t) => {
  const { host } = await liveHost(t, { connectionIdleMs: 150 });
  const { connect } = await import('node:net');
  const closed = await new Promise((resolve) => {
    const socket = connect(host.socketPath);
    socket.on('close', () => resolve(true));
    socket.on('error', () => resolve(true));
    setTimeout(() => resolve(false), 3000);
  });
  assert.equal(closed, true, 'the host closed the idle connection itself');
});

test('a fetch that never answers is aborted, and the host says so', async (t) => {
  const aborted = [];
  const fetchFn = (_url, options) => new Promise((_ignored, reject) => {
    options.signal.addEventListener('abort', () => {
      aborted.push(true);
      reject(new Error('The operation was aborted'));
    });
  });
  const { host, failed, shown } = await liveHost(t, { fetchFn, fetchTimeoutMs: 200 });
  const { reply } = await show(host, 'IC-72');
  assert.equal(reply.status, 'accepted', 'the picker is answered immediately, not held for the fetch');
  assert.equal(await until(() => failed.length === 1, 3000), true);
  assert.equal(aborted.length, 1, 'the request was actually aborted, not just given up on');
  assert.match(failed[0].reason, /took longer than 200ms/);
  assert.equal(shown.length, 0);
});

test('a failed fetch is reported to the entrypoint rather than rendered as an issue', async (t) => {
  const fetchFn = async () => { throw new Error('network is down'); };
  const { host, failed, shown } = await liveHost(t, { fetchFn });
  await show(host, 'IC-72');
  assert.equal(await until(() => failed.length === 1), true);
  assert.deepEqual(failed[0], { identifier: 'IC-72', reason: 'network is down' });
  assert.equal(shown.length, 0);
});

// ---------------------------------------------------------------------------
// What the pane carries

test('published metadata locates the host without publishing a path or a key', () => {
  const args = hostMetadataArgs(PANE, {
    pid: 4242, instance: 'i0', socketPath: '/tmp/wfl-host-x/y.sock', checkout: '/wt/ic-72',
  });
  assert.deepEqual(args.slice(0, 5), ['pane', 'report-metadata', PANE, '--source', 'tdi.worktree-from-linear']);
  const tokens = Object.fromEntries(
    args.filter((_a, i) => args[i - 1] === '--token').map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]),
  );
  assert.equal(tokens['wfl-host-pid'], '4242');
  assert.equal(tokens['wfl-host-id'], 'i0');
  assert.equal(tokens['wfl-host-sock'], '/tmp/wfl-host-x/y.sock');
  // The checkout is a digest: enough to tell "this host is for that worktree" apart from
  // "some other worktree", without writing the path into pane metadata.
  assert.equal(tokens['wfl-host-cwd'], checkoutDigest('/wt/ic-72'));
  assert.equal(tokens['wfl-host-cwd'].includes('/'), false);
  // Every token name is within herdr's [A-Za-z0-9_-]{1,32}.
  for (const name of Object.keys(tokens)) assert.match(name, /^[A-Za-z0-9_-]{1,32}$/);
  const cleared = hostMetadataClearArgs(PANE);
  assert.deepEqual(cleared.filter((_a, i) => cleared[i - 1] === '--clear-token'),
    ['wfl-host-pid', 'wfl-host-id', 'wfl-host-sock', 'wfl-host-cwd']);
});

// ---------------------------------------------------------------------------
// The entrypoint

test('a host that cannot publish stops listening instead of leaving a socket behind', async (t) => {
  const dir = tempDir(t, 'wfl-main-');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ linearApiKey: 'k' }));
  // A herdr that is not there at all: publishing fails immediately.
  const installed = [];
  // Pin where the host will put its socket home, so the leftover scan below
  // reads the directory it actually used. Without this the scan looks in
  // tmpdir() while runtimeBase() prefers XDG_RUNTIME_DIR — set on most Linux
  // desktops and CI runners — and the assertion passes without proving
  // anything.
  const runtime = tempDir(t, 'wfl-runtime-');
  const previousRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtime;
  t.after(() => {
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntime;
  });
  // Compare against what was already there: a host killed outright (SIGKILL runs no exit
  // handler) can leave a directory behind, and that is not this call's doing.
  const isSocketHome = (name) => /^wfl-[A-Za-z0-9]{6}$/.test(name);
  // Prove the scan is aimed where the host will actually build: a default home
  // follows XDG_RUNTIME_DIR, so this is the directory main() is about to use.
  const probe = createSocketHome();
  assert.equal(probe.ok, true, probe.error);
  assert.equal(probe.dir.startsWith(realpathSync(runtime)), true,
    `default socket home ${probe.dir} is not under the pinned ${runtime}`);
  rmSync(probe.dir, { recursive: true, force: true });
  const before = new Set(readdirSync(runtime).filter(isSocketHome));
  const code = await hostMain({
    argv: ['--pane', PANE, '--config-dir', dir, '--cwd', dir],
    env: { HERDR_BIN_PATH: join(dir, 'herdr-that-does-not-exist') },
    cwd: dir,
    // main() is being called in-process here, so its process-wide handlers are collected
    // rather than installed on the test runner.
    install: (cleanup) => installed.push(cleanup),
  });
  assert.equal(code, 1);
  assert.equal(installed.length, 1, 'it still arranged its own cleanup');
  // Nothing is listening and nothing is left on disk: no socket, no directory.
  const leftovers = readdirSync(runtime).filter((name) => isSocketHome(name) && !before.has(name));
  assert.deepEqual(leftovers, [], `left behind: ${leftovers.join(', ')}`);
});


test('native metadata never silently truncates the host socket path', () => {
  const host = { paneId: PANE, pid: 4242, instance: 'i0', socketPath: '/'+ 'a'.repeat(80), checkout: '/wt' };
  const result = publishHost(host, { herdrBin: 'herdr', exec: () => assert.fail('overlong path must not publish') });
  assert.equal(result.ok, false);
  assert.match(result.error, /metadata limits/);
});
