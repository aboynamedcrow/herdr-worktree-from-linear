import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readIssueIds } from '../lib/issue-list.js';
import { createListMode } from '../lib/list-mode.js';
import { listKeyAction, openInLinear } from '../lib/list-keys.js';
import { formatIssueList } from '../lib/render.js';

const ids = ['IC-1', 'IC-2', 'HSYS-3', 'IC-4'];

function gitReader(values = {}) {
  const calls = [];
  const exec = (cmd, args, options) => {
    calls.push([cmd, ...args]);
    assert.equal(cmd, 'git');
    assert.deepEqual(args.slice(0, 4), ['-C', '/worktree', 'config', '--worktree']);
    assert.deepEqual(args.slice(4, 5), ['--get-all']);
    assert.ok(['harkness.issues', 'harkness.tracker'].includes(args[5]));
    assert.ok(options.timeout > 0);
    const value = values[args[5]];
    return value === undefined ? { status: 1, stdout: '' } : { status: 0, stdout: `${value.join('\n')}\n` };
  };
  return { calls, read: () => readIssueIds('/worktree', exec) };
}

test('the Git reader handles empty, tracker, four, duplicate, and invalid values', () => {
  assert.deepEqual(gitReader().read(), []);
  assert.deepEqual(gitReader({ 'harkness.tracker': ['IC-8'] }).read(), ['IC-8']);
  const four = gitReader({ 'harkness.issues': [...ids, 'IC-2', 'bad', 'IC-0', 'IC-5 extra'] });
  assert.deepEqual(four.read(), ids);
  assert.equal(four.calls.length, 1, 'a present list needs no tracker call');
});

function harness(initial = ids) {
  let next = [...initial];
  let time = 1000;
  let fail = false;
  const calls = [];
  const views = [];
  const mode = createListMode({
    checkout: '/worktree', configDir: '/cfg', read: () => [...next], now: () => time,
    load: (_dir, _cwd, _env, id) => ({ linearApiKey: 'secret', id }),
    fetchBatch: async (_config, list) => {
      calls.push([...list]);
      if (fail) throw new Error('offline');
      return new Map(list.map((id) => [id, { identifier: id, stateName: 'Todo', title: `Title ${id}`, url: `https://linear.app/a/issue/${id}` }]));
    },
    fetchOne: async (_config, id) => ({ identifier: id, title: `Delivered ${id}` }),
    onUpdate: (view) => views.push(view),
  });
  return { mode, calls, views, setIds: (value) => { next = value; }, advance: (ms) => { time += ms; }, fail: () => { fail = true; } };
}

test('list changes keep a selected ID, replace a removed ID, and fetch one batch', async () => {
  const h = harness();
  await h.mode.poll();
  assert.deepEqual(h.calls, [ids]);
  h.mode.select(1);
  assert.equal(h.mode.view().selected, 'IC-2');
  h.setIds([...ids, 'IC-5']);
  await h.mode.poll();
  assert.equal(h.mode.view().selected, 'IC-2');
  assert.deepEqual(h.calls[1], [...ids, 'IC-5']);
  h.setIds(['IC-1', 'HSYS-3', 'IC-4', 'IC-5']);
  await h.mode.poll();
  assert.equal(h.mode.view().selected, 'IC-1');
  assert.deepEqual(h.calls[2], ['IC-1', 'HSYS-3', 'IC-4', 'IC-5']);
  const renders = h.views.length;
  await h.mode.poll();
  assert.equal(h.views.length, renders, 'unchanged list does not redraw');
  h.advance(60000);
  await h.mode.poll();
  assert.equal(h.calls.length, 4, 'the minute refresh is one batch');
});

test('selection stops at both ends and delivery lasts until the list changes', async () => {
  const h = harness(['IC-1', 'IC-2']);
  await h.mode.poll();
  assert.equal(h.mode.select(-1), false);
  assert.equal(h.mode.select(1), true);
  assert.equal(h.mode.select(1), false);
  await h.mode.deliver('IC-9');
  assert.equal(h.mode.view().selected, 'IC-9');
  assert.equal(h.mode.view().override, 'IC-9');
  await h.mode.poll();
  assert.equal(h.mode.view().selected, 'IC-9');
  h.setIds(['IC-1', 'IC-2', 'IC-3']);
  await h.mode.poll();
  assert.equal(h.mode.view().selected, 'IC-1');
  assert.equal(h.mode.view().override, null);
});

test('a failed refresh keeps the last good issue data and shows one error', async () => {
  const h = harness(['IC-1']);
  await h.mode.poll();
  h.fail();
  h.advance(60000);
  await h.mode.poll();
  assert.equal(h.mode.view().issues.get('IC-1').title, 'Title IC-1');
  assert.match(h.mode.view().error, /offline/);
  assert.equal(h.mode.view().error.includes('secret'), false);
});

test('mixed Linear credentials get one bounded batch each', async () => {
  const calls = [];
  const mode = createListMode({
    checkout: '/worktree', configDir: '/cfg', read: () => ['IC-1', 'HSYS-2', 'IC-3'],
    load: (_dir, _cwd, _env, id) => ({ linearApiKey: id.startsWith('IC-') ? 'ic-secret' : 'hsys-secret' }),
    fetchBatch: async (config, values) => {
      calls.push([config.linearApiKey, values]);
      return new Map(values.map((id) => [id, { identifier: id, title: id }]));
    },
    onUpdate: () => {},
  });
  await mode.poll();
  assert.deepEqual(calls, [['ic-secret', ['IC-1', 'IC-3']], ['hsys-secret', ['HSYS-2']]]);
  assert.equal(mode.view().issues.size, 3);
});

test('the list renders zero, one, and four issues with a marker and narrow title', () => {
  const empty = { ids: [], selected: null, issues: new Map(), error: '', override: null };
  assert.equal(formatIssueList(empty), '');
  const one = { ...empty, ids: ['IC-1'], selected: 'IC-1', issues: new Map([['IC-1', { identifier: 'IC-1', title: 'One', stateName: 'Todo' }]]) };
  assert.match(formatIssueList(one), /▸ IC-1  Todo  One/);
  const many = { ...one, ids, issues: new Map(ids.map((id) => [id, { identifier: id, title: 'A title longer than this narrow pane', stateName: 'Todo' }])) };
  const list = formatIssueList(many, 28);
  assert.equal(list.split('\n').filter((row) => /IC-[124]|HSYS-3/.test(row)).length >= 4, true);
  assert.ok(list.split('\n')[0].length <= 26);
});

test('j, k, Enter, o, and q map to list actions', () => {
  assert.deepEqual([0x6a, 0x6b, 0x0d, 0x6f, 0x71].map(listKeyAction),
    ['next', 'previous', 'full', 'open', 'quit']);
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
