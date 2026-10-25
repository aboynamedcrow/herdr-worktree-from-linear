import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLine, formatLines, lineToIssue, fzfArgs, selectWorktree, select, nodeSelect } from '../lib/picker.js';

test('fzfArgs adds --layout=reverse only for the top layout', () => {
  assert.deepEqual(fzfArgs('top'), ['--layout=reverse', '--height=~40%', '--prompt', 'issue> ']);
  assert.deepEqual(fzfArgs('down'), ['--height=~40%', '--prompt', 'issue> ']);
  assert.deepEqual(fzfArgs(undefined), ['--height=~40%', '--prompt', 'issue> ']);
});

const ISSUES = [
  { identifier: 'BIT-990', title: 'Label API keys', branchName: 'tdi/bit-990-label', stateName: 'In Progress', assignee: 'Darek' },
  { identifier: 'BIT-988', title: 'REST API [v2]', branchName: 'tdi/bit-988-rest', stateName: 'Todo', assignee: '' },
];

test('formatLine leads with the identifier and shows state', () => {
  assert.match(formatLine(ISSUES[0]), /^BIT-990\s+In Progress\s+Label API keys\s+@Darek$/);
  assert.match(formatLine(ISSUES[1]), /^BIT-988\s+Todo\s+REST API \[v2\]$/);
});

test('lineToIssue maps a chosen line back by leading identifier', () => {
  const lines = formatLines(ISSUES);
  assert.equal(lineToIssue(lines[0], ISSUES).identifier, 'BIT-990');
  assert.equal(lineToIssue(lines[1], ISSUES).identifier, 'BIT-988');   // title contains '[v2]' but leading token wins
  assert.equal(lineToIssue('', ISSUES), null);
  assert.equal(lineToIssue('NOPE-1 gone', ISSUES), null);
});


test('worktree ambiguity requires an exact candidate and supports cancellation', async () => {
  const candidates = [{ id: 'a'.repeat(64), branch: 'legacy/ic-72', path: '/a', checkout: true, existing: true },
    { id: 'b'.repeat(64), branch: 'other/ic-72', path: '/b', checkout: true, existing: true }];
  assert.equal(await selectWorktree([candidates[0]], { exec: () => assert.fail('sole choice needs no chooser') }), candidates[0]);
  for (const [status, output, expected] of [[0, `${candidates[1].id}  other/ic-72`, candidates[1]], [130, '', null], [0, 'unknown', null]]) {
    const chosen = await selectWorktree(candidates, { exec: (cmd, args, opts) => {
      if (cmd === 'sh') return { status: 0 };
      assert.equal(cmd, 'fzf'); assert.ok(args.includes('worktree> '));
      assert.ok(opts.input.includes('/a') && opts.input.includes('/b'));
      return { status, stdout: output };
    } });
    assert.equal(chosen, expected);
  }
});

test('a sole lifecycle choice shows unknown states and supports cancellation', async () => {
  const candidate = { id: 'a'.repeat(64), branch: 'legacy/ic-72', path: '/a', checkout: true,
    existing: true, source: 'local', action: 'open checkout', pr_state: 'UNKNOWN',
    recommended: true, start_commit: 'f'.repeat(40) };
  let prompted = false;
  const chosen = await selectWorktree([candidate], { remoteState: 'UNKNOWN', exec: (cmd, args, opts) => {
    if (cmd === 'sh') return { status: 0 };
    prompted = true;
    assert.match(opts.input, /PR UNKNOWN/);
    assert.match(opts.input, /remote UNKNOWN/);
    assert.match(opts.input, /recommended/);
    assert.match(opts.input, /ffffffffffff/);
    return { status: 130, stdout: '' };
  } });
  assert.equal(prompted, true);
  assert.equal(chosen, null);
});

test('remote restore choice retains the exact backend id', async () => {
  const candidate = { id: 'a'.repeat(64), branch: 'legacy/ic-72', path: '/a', checkout: false,
    existing: false, source: 'remote', action: 'restore remote branch', pr_state: 'CLOSED',
    recommended: true, start_commit: 'f'.repeat(40) };
  const chosen = await selectWorktree([candidate], { exec: (cmd, args, opts) => {
    if (cmd === 'sh') return { status: 0 };
    assert.match(opts.input, /restore remote branch · remote · PR CLOSED/);
    return { status: 0, stdout: opts.input };
  } });
  assert.equal(chosen, candidate);
});

for (const [type, name, icon] of [
  ['triage', 'Triage', '◇'], ['backlog', 'Backlog', '◌'], ['unstarted', 'Todo', '○'],
  ['started', 'In Progress', '◐'], ['started', 'In REVIEW', '◕'], ['completed', 'Done', '●'],
  ['canceled', 'Canceled', '⊘'], ['duplicate', 'Duplicate', '⊘'], ['unknown', 'Other', ''],
]) {
  test(`row renders ${type} ${name}`, () => {
    assert.equal(formatLine({ identifier: 'IC-1', title: 'Title', stateType: type, stateName: name }),
      `IC-1  ${icon ? `${icon} ` : ''}${name}  Title`);
  });
}

test('row colors only the icon and includes the project and owner', () => {
  const issue = { identifier: 'IC-1516', title: 'Title', stateType: 'started', stateName: 'In Progress',
    stateColor: '#aB12ff', project: 'Project', assignee: 'owner' };
  assert.equal(formatLine(issue), 'IC-1516  \x1b[38;2;171;18;255m◐\x1b[0m In Progress  Title  [Project] @owner');
  for (const stateColor of [undefined, '', '#fff', 'red', '#gg0000', '#1234567']) {
    assert.equal(formatLine({ ...issue, stateColor }).includes('\x1b'), false);
  }
  assert.equal(lineToIssue(formatLine(issue), [issue]), issue);
});

test('row truncates titles at 60 code points', () => {
  for (const letter of ['a', '😀']) {
    assert.equal(formatLine({ identifier: 'IC-1', title: letter.repeat(61) }), `IC-1  ${letter.repeat(59)}…`);
    assert.equal(formatLine({ identifier: 'IC-1', title: letter.repeat(60) }), `IC-1  ${letter.repeat(60)}`);
  }
});

async function pick(query, row, options = {}, status = 0, issues = ISSUES) {
  return select(issues, { ...options, exec: (cmd, args, opts) => {
    if (cmd === 'sh') return { status: 0 };
    assert.equal(cmd, 'fzf');
    for (const flag of ['--ansi', '--print-query', '--bind', 'enter:accept-or-print-query']) assert.ok(args.includes(flag));
    assert.equal(opts.input, formatLines(issues).join('\n'));
    return { status, stdout: `${query}\n${row ? formatLine(row) : query}\n` };
  } });
}

test('full ID wins over another highlighted row and accepts lowercase', async () => {
  assert.equal(await pick('BIT-990', ISSUES[1]), 'BIT-990');
  assert.equal(await pick('bit-990', ISSUES[1]), 'BIT-990');
  assert.equal(await pick('ic-1516', ISSUES[1]), 'IC-1516');
});

test('bare numbers use the configured team only without a selected row', async () => {
  assert.equal(await pick('1516', null, { idTeamKey: 'ic', teamKey: 'BIT' }), 'IC-1516');
  assert.equal(await pick('1516', null, { teamKey: 'BIT' }), 'BIT-1516');
  assert.equal(await pick('1516', null), null);
  assert.equal(await pick('1516', ISSUES[1], { idTeamKey: 'IC' }), ISSUES[1]);
  assert.equal(await pick('title', ISSUES[1]), ISSUES[1]);
  assert.equal(await pick('1516', ISSUES[1]), ISSUES[1]);
});

test('a bare number with a team keeps the highlighted issue instead of another exact ID', async () => {
  const highlighted = { ...ISSUES[0], identifier: 'IC-1545' };
  assert.equal(await pick('154', highlighted, { idTeamKey: 'IC' }, 0, [highlighted]), highlighted);
});

test('empty lists permit ID lookup and Esc or Ctrl-C cancels', async () => {
  assert.equal(await pick('ic-1516', null, {}, 0, []), 'IC-1516');
  assert.equal(await pick('IC-1516', null, {}, 130), null);
  assert.equal(await pick('', null), null);
});

test('numbered fallback accepts IDs and keeps row numbers ahead of team lookup', async () => {
  for (const [answer, options, expected] of [
    ['bit-990', {}, 'BIT-990'], ['ic-1516', {}, 'IC-1516'],
    ['1516', { idTeamKey: 'IC', teamKey: 'BIT' }, 'IC-1516'],
    ['1516', { teamKey: 'BIT' }, 'BIT-1516'], ['1516', {}, null],
    ['2', { idTeamKey: 'IC' }, ISSUES[1]], ['', {}, null],
  ]) {
    const input = new PassThrough();
    const output = new PassThrough();
    const pending = nodeSelect(ISSUES, formatLines(ISSUES), undefined, { input, output, identifiers: true, ...options });
    input.end(`${answer}\n`);
    assert.equal(await pending, expected);
  }
});

test('select uses the numbered fallback without fzf', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = select([], { exec: () => ({ status: 1 }), input, output });
  input.end('ic-1516\n');
  assert.equal(await pending, 'IC-1516');
});

test('unknown inherited state names still have no icon', () => {
  assert.equal(formatLine({ identifier: 'IC-1', title: 'Title', stateType: 'constructor', stateName: 'Other' }), 'IC-1  Other  Title');
});

test('numbered fallback cancels when input closes', async () => {
  const input = new PassThrough();
  const pending = nodeSelect([], [], undefined, { input, output: new PassThrough(), identifiers: true });
  input.end();
  assert.equal(await pending, null);
});
