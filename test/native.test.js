import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callJson, callVoid, focusPane, notificationArgs, paneFocusRequest, paneGetArgs, paneListArgs,
  paneProcessInfoArgs, paneRunArgs, readFocusReply, reportMetadataArgs, tabListArgs,
} from '../lib/native.js';

test('inventory commands are always scoped to an explicit workspace', () => {
  assert.deepEqual(tabListArgs('w9'), ['tab', 'list', '--workspace', 'w9']);
  assert.deepEqual(paneListArgs('w9'), ['pane', 'list', '--workspace', 'w9']);
});

// `pane process-info` parses its target with parse_optional_current_pane_args, which
// rejects a bare id as "unknown option" (status 2) and, with no target at all, lets the
// server fall back to whatever pane is focused. Both would be silent misbehavior.
test('pane process-info names its pane with --pane, never positionally', () => {
  assert.deepEqual(paneProcessInfoArgs('w9:p2'), ['pane', 'process-info', '--pane', 'w9:p2']);
});

test('the positional pane commands stay positional', () => {
  assert.deepEqual(paneGetArgs('w9:p2'), ['pane', 'get', 'w9:p2']);
  assert.deepEqual(paneRunArgs('w9:p2', 'echo hi'), ['pane', 'run', 'w9:p2', 'echo hi']);
  assert.deepEqual(notificationArgs('Title', 'Body'), ['notification', 'show', 'Title', '--body', 'Body']);
});

test('reportMetadataArgs sets and clears tokens under one source', () => {
  assert.deepEqual(reportMetadataArgs('w9:p2', 'src', { a: '1', b: '2' }, ['c']), [
    'pane', 'report-metadata', 'w9:p2', '--source', 'src',
    '--token', 'a=1', '--token', 'b=2', '--clear-token', 'c',
  ]);
  assert.deepEqual(reportMetadataArgs('w9:p2', 'src'), ['pane', 'report-metadata', 'w9:p2', '--source', 'src']);
});

test('callJson separates a failed command from an unreadable reply', () => {
  const ok = callJson(() => ({ status: 0, stdout: '{"result":{"type":"ok"}}', stderr: '' }), 'herdr', paneGetArgs('w9:p2'));
  assert.deepEqual(ok, { ok: true, result: { type: 'ok' } });

  const failed = callJson(() => ({ status: 1, stdout: '', stderr: ' pane not found \n' }), 'herdr', paneGetArgs('w9:p2'));
  assert.deepEqual(failed, { ok: false, error: 'herdr pane get failed: pane not found' });

  // A server error with an empty stderr still has to say something.
  assert.match(callJson(() => ({ status: 2, stdout: '', stderr: '' }), 'herdr', paneListArgs('w9')).error, /status 2/);
  assert.match(callJson(() => ({ status: 0, stdout: 'herdr: hello', stderr: '' }), 'herdr', paneListArgs('w9')).error, /unparseable/);
  assert.match(callJson(() => ({ status: 0, stdout: '{"id":"x"}', stderr: '' }), 'herdr', paneListArgs('w9')).error, /no result/);
  assert.match(callJson(() => ({ status: 0, stdout: '{"result":[]}', stderr: '' }), 'herdr', paneListArgs('w9')).error, /no result/);
});

test('a herdr binary that cannot be spawned is a diagnostic, not a crash', () => {
  const boom = () => { throw new Error('ENOENT'); };
  assert.match(callJson(boom, 'herdr', paneListArgs('w9')).error, /pane list could not run: ENOENT/);
  assert.match(callVoid(boom, 'herdr', paneRunArgs('w9:p2', 'x')).error, /pane run could not run: ENOENT/);
});

// `pane run` and `pane report-metadata` can legitimately print nothing, so exit status is
// the only signal available for them.
test('callVoid judges acting commands by exit status alone', () => {
  assert.deepEqual(callVoid(() => ({ status: 0, stdout: '', stderr: '' }), 'herdr', paneRunArgs('w9:p2', 'x')), { ok: true });
  assert.match(callVoid(() => ({ status: 1, stdout: '', stderr: 'nope' }), 'herdr', paneRunArgs('w9:p2', 'x')).error, /pane run failed: nope/);
  assert.match(callVoid(() => undefined, 'herdr', paneRunArgs('w9:p2', 'x')).error, /pane run failed/);
});

// ---------------------------------------------------------------------------
// pane.focus over the socket

test('paneFocusRequest names the pane and carries a unique id', () => {
  const first = paneFocusRequest('w9:p2');
  assert.equal(first.method, 'pane.focus');
  assert.deepEqual(first.params, { pane_id: 'w9:p2' });
  assert.notEqual(paneFocusRequest('w9:p2').id, first.id, 'ids do not repeat within a process');
});

test('readFocusReply accepts only an answer to this request about this pane', () => {
  const good = JSON.stringify({ id: 'r1', result: { type: 'pane_info', pane: { pane_id: 'w9:p2' } } });
  assert.equal(readFocusReply(good, 'r1', 'w9:p2').ok, true);
  // Someone else's reply on a shared connection is not this request's answer.
  assert.match(readFocusReply(good, 'r2', 'w9:p2').error, /replied to "r1"/);
  // The server says which pane it actually focused; a different one means we did not
  // focus what we asked for.
  assert.match(readFocusReply(good, 'r1', 'w9:p9').error, /focused w9:p2, not w9:p9/);
  assert.match(readFocusReply(JSON.stringify({ id: 'r1', error: { code: 'pane_not_found', message: 'pane w9:p2 not found' } }), 'r1', 'w9:p2').error,
    /failed: pane_not_found: pane w9:p2 not found/);
  assert.match(readFocusReply(JSON.stringify({ id: 'r1', result: { type: 'ok' } }), 'r1', 'w9:p2').error, /no pane/);
  assert.match(readFocusReply('not json', 'r1', 'w9:p2').error, /unparseable/);
  assert.match(readFocusReply('[]', 'r1', 'w9:p2').error, /no reply object/);
});

// A real unix socket, spoken to exactly the way herdr's own plugin clients speak to it:
// newline-delimited JSON, one request line in, one reply line out.
function socketServer(t, handler) {
  const dir = mkdtempSync(join(tmpdir(), 'wfl-sock-'));
  const path = join(dir, 's');
  const server = createServer((conn) => {
    let buffer = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const request = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      handler(JSON.parse(request), conn);
    });
    conn.on('error', () => {});
  });
  t.after(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });
  return new Promise((resolve) => server.listen(path, () => resolve(path)));
}

test('focusPane focuses an exact pane over a real socket', async (t) => {
  const seen = [];
  const path = await socketServer(t, (request, conn) => {
    seen.push(request);
    conn.write(`${JSON.stringify({ id: request.id, result: { type: 'pane_info', pane: { pane_id: request.params.pane_id, label: 'Issue / Utility' } } })}\n`);
  });
  const out = await focusPane('w9:p2', { socketPath: path });
  assert.equal(out.ok, true);
  assert.equal(out.pane.pane_id, 'w9:p2');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'pane.focus');
  assert.deepEqual(seen[0].params, { pane_id: 'w9:p2' });
  assert.equal(typeof seen[0].id, 'string');
});

test('focusPane surfaces a server error rather than reporting success', async (t) => {
  const path = await socketServer(t, (request, conn) => {
    conn.write(`${JSON.stringify({ id: request.id, error: { code: 'pane_not_found', message: 'pane w9:p2 not found' } })}\n`);
  });
  const out = await focusPane('w9:p2', { socketPath: path });
  assert.equal(out.ok, false);
  assert.match(out.error, /pane_not_found/);
});

test('focusPane rejects a reply about a different pane', async (t) => {
  const path = await socketServer(t, (request, conn) => {
    conn.write(`${JSON.stringify({ id: request.id, result: { type: 'pane_info', pane: { pane_id: 'w9:p7' } } })}\n`);
  });
  assert.match((await focusPane('w9:p2', { socketPath: path })).error, /focused w9:p7, not w9:p2/);
});

test('focusPane rejects a reply carrying another request id', async (t) => {
  const path = await socketServer(t, (_request, conn) => {
    conn.write(`${JSON.stringify({ id: 'someone-else', result: { type: 'pane_info', pane: { pane_id: 'w9:p2' } } })}\n`);
  });
  assert.match((await focusPane('w9:p2', { socketPath: path })).error, /replied to "someone-else"/);
});

test('focusPane gives up on a server that accepts and never answers', async (t) => {
  const path = await socketServer(t, () => { /* deliberately silent */ });
  const started = Date.now();
  const out = await focusPane('w9:p2', { socketPath: path, timeoutMs: 150 });
  assert.equal(out.ok, false);
  assert.match(out.error, /timed out after 150ms/);
  assert.ok(Date.now() - started < 5000, 'returned on the deadline, not on the default');
});

test('focusPane reports a closed or unreachable socket instead of hanging', async (t) => {
  const path = await socketServer(t, (_request, conn) => conn.end());
  assert.match((await focusPane('w9:p2', { socketPath: path })).error, /closed before replying/);
  const missing = await focusPane('w9:p2', { socketPath: join(tmpdir(), 'wfl-no-such-socket') });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /socket error|could not be opened/);
});

test('focusPane refuses when herdr injected no socket path', async () => {
  const out = await focusPane('w9:p2', {});
  assert.equal(out.ok, false);
  assert.match(out.error, /HERDR_SOCKET_PATH is not set/);
});
