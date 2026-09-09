import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  callJson, callVoid, notificationArgs, paneFocusArgs, paneGetArgs, paneListArgs,
  paneProcessInfoArgs, paneRunArgs, reportMetadataArgs, tabListArgs,
} from '../lib/native.js';

test('inventory commands are always scoped to an explicit workspace', () => {
  assert.deepEqual(tabListArgs('w9'), ['tab', 'list', '--workspace', 'w9']);
  assert.deepEqual(paneListArgs('w9'), ['pane', 'list', '--workspace', 'w9']);
});

test('pane commands take the pane id positionally', () => {
  assert.deepEqual(paneProcessInfoArgs('w9:p2'), ['pane', 'process-info', 'w9:p2']);
  assert.deepEqual(paneGetArgs('w9:p2'), ['pane', 'get', 'w9:p2']);
  assert.deepEqual(paneFocusArgs('w9:p2'), ['pane', 'focus', 'w9:p2']);
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

// `pane run`, `pane focus` and `pane report-metadata` can legitimately print nothing, so
// exit status is the only signal available for them.
test('callVoid judges acting commands by exit status alone', () => {
  assert.deepEqual(callVoid(() => ({ status: 0, stdout: '', stderr: '' }), 'herdr', paneRunArgs('w9:p2', 'x')), { ok: true });
  assert.match(callVoid(() => ({ status: 1, stdout: '', stderr: 'nope' }), 'herdr', paneFocusArgs('w9:p2')).error, /pane focus failed: nope/);
  assert.match(callVoid(() => undefined, 'herdr', paneFocusArgs('w9:p2')).error, /pane focus failed/);
});
