import { runCmd } from './exec.js';

const ID = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/;

export function validListId(value) {
  return typeof value === 'string' && ID.test(value);
}

export function parseIssueValues(text) {
  const seen = new Set();
  return String(text || '').split('\n').filter((id) => {
    if (!validListId(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function readIssueIds(cwd, exec = runCmd) {
  const read = (key) => {
    const result = exec('git', ['-C', cwd, 'config', '--worktree', '--get-all', key], { timeout: 5000 });
    if (result.status === 1) return [];
    if (result.status !== 0) throw new Error(`git config could not read ${key}`);
    return parseIssueValues(result.stdout);
  };
  const ids = read('harkness.issues');
  return ids.length ? ids : read('harkness.tracker').slice(0, 1);
}
