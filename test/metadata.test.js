import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkspaceId, buildReportArgs, reportIssue } from '../lib/metadata.js';

const CREATED = JSON.stringify({
  id: 'cli:worktree:create',
  result: {
    type: 'worktree_created',
    root_pane: { pane_id: 'w42:p1', workspace_id: 'w42' },
    workspace: { workspace_id: 'w42', label: 'bit-1234-fix' },
  },
});

test('parseWorkspaceId reads the documented worktree create shape', () => {
  assert.equal(parseWorkspaceId(CREATED), 'w42');
});

test('parseWorkspaceId falls back to a nested id when the shape moves', () => {
  const moved = JSON.stringify({ result: { type: 'worktree_opened', target: { open_workspace_id: 'w7' } } });
  assert.equal(parseWorkspaceId(moved), 'w7');
});

test('parseWorkspaceId returns null for junk instead of throwing', () => {
  assert.equal(parseWorkspaceId('not json'), null);
  assert.equal(parseWorkspaceId('{"result":{"type":"worktree_created"}}'), null);
  assert.equal(parseWorkspaceId(''), null);
});

test('buildReportArgs targets the workspace with this plugin as the source', () => {
  assert.deepEqual(buildReportArgs('w42', 'BIT-1234'), [
    'workspace', 'report-metadata', 'w42',
    '--source', 'plugin:tdi.worktree-from-linear',
    '--token', 'linear=BIT-1234',
  ]);
});

test('reportIssue reports the identifier and asks for no TTL', () => {
  const calls = [];
  const exec = (cmd, args) => (calls.push([cmd, ...args]), { status: 0, stdout: '', stderr: '' });
  assert.equal(reportIssue('w42', 'BIT-1234', { exec, herdrBin: 'herdr' }), true);
  assert.deepEqual(calls, [['herdr', 'workspace', 'report-metadata', 'w42',
    '--source', 'plugin:tdi.worktree-from-linear', '--token', 'linear=BIT-1234']]);
  assert.equal(calls[0].includes('--ttl-ms'), false);
});

test('reportIssue does nothing without a workspace id or an identifier', () => {
  const calls = [];
  const exec = (cmd, args) => (calls.push([cmd, ...args]), { status: 0, stdout: '', stderr: '' });
  assert.equal(reportIssue(null, 'BIT-1', { exec }), false);
  assert.equal(reportIssue('w42', '', { exec }), false);
  assert.deepEqual(calls, []);
});

test('reportIssue warns and keeps going when herdr rejects the report', () => {
  const warnings = [];
  const exec = () => ({ status: 1, stdout: '', stderr: 'unrecognized subcommand\n' });
  assert.equal(reportIssue('w42', 'BIT-1234', { exec, warn: (m) => warnings.push(m) }), false);
  assert.match(warnings[0], /sidebar issue label failed: unrecognized subcommand/);
});

test('reportIssue names a spawn failure rather than calling it exit 1', () => {
  const warnings = [];
  const exec = () => ({ status: 1, stdout: '', stderr: '', error: new Error('spawn herdr ENOENT') });
  reportIssue('w42', 'BIT-1234', { exec, warn: (m) => warnings.push(m) });
  assert.match(warnings[0], /ENOENT/);
});

test('reportIssue warns after a thrown command without changing worktree success', () => {
  const warnings = [];
  assert.equal(reportIssue('w42', 'BIT-1', {
    exec() { throw new Error('spawn failure'); }, warn: (message) => warnings.push(message),
  }), false);
  assert.match(warnings[0], /spawn failure/);
});
