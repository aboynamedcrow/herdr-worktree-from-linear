import { loadConfig } from './config.js';
import { readIssueIds } from './issue-list.js';
import { fetchIssue, fetchIssueBatch } from './linear.js';

const same = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);
const shortError = (error, key = '') => String(error?.message || error || 'request failed')
  .replaceAll(key || '\0', '[redacted]').replace(/[\r\n]+/g, ' ').slice(0, 120);

export function createListMode({
  checkout, configDir, onUpdate, read = readIssueIds, load = loadConfig,
  fetchBatch = fetchIssueBatch, fetchOne = fetchIssue, fetchFn = fetch,
  now = Date.now, pollMs = 2000, refreshMs = 60000, setTimer = setInterval, clearTimer = clearInterval,
}) {
  let ids = [];
  let selected = null;
  let override = null;
  let data = new Map();
  let error = '';
  let lastFetchAt = 0;
  let generation = 0;
  let fetching = false;
  let timer = null;
  let closed = false;
  const view = () => ({ ids: [...ids], selected, issues: new Map(data), error, override });
  const emit = () => { if (!closed) onUpdate(view()); };

  async function refresh() {
    if (closed || !ids.length || fetching) return;
    fetching = true;
    const current = generation;
    const snapshot = [...ids];
    try {
      const groups = new Map();
      const problems = [];
      for (const id of snapshot) {
        try {
          const config = load(configDir, checkout, process.env, id);
          const group = groups.get(config.linearApiKey) || { config, ids: [] };
          group.ids.push(id);
          groups.set(config.linearApiKey, group);
        } catch (cause) { problems.push(`${id}: ${shortError(cause)}`); }
      }
      const results = await Promise.all([...groups.values()].map(async ({ config, ids: groupIds }) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        try {
          return { issues: await fetchBatch(config, groupIds,
            (url, options) => fetchFn(url, { ...options, signal: controller.signal })) };
        } catch (cause) {
          return { error: `${groupIds.join(', ')}: ${shortError(cause, config.linearApiKey)}` };
        } finally { clearTimeout(timeout); }
      }));
      if (closed || current !== generation) return;
      const fresh = new Map();
      for (const result of results) {
        if (result.error) problems.push(result.error);
        else for (const entry of result.issues) fresh.set(...entry);
      }
      const previous = data;
      data = new Map([...data, ...fresh]);
      const missing = snapshot.filter((id) => !fresh.has(id) && !problems.some((problem) => problem.startsWith(`${id}:`)));
      const nextError = problems.length ? `Linear: ${problems[0]}`.slice(0, 120)
        : missing.length ? `Linear: no details for ${missing.join(', ')}`.slice(0, 120) : '';
      if (JSON.stringify([...previous]) !== JSON.stringify([...data]) || error !== nextError) {
        error = nextError;
        emit();
      }
    } catch (cause) {
      if (closed || current !== generation) return;
      error = `Linear: ${shortError(cause)}`;
      emit();
    } finally {
      fetching = false;
      lastFetchAt = now();
      if (!closed && current !== generation && ids.length) void refresh();
    }
  }

  async function poll() {
    if (closed) return;
    let next;
    try { next = read(checkout); }
    catch (cause) {
      const message = `Git: ${shortError(cause)}`;
      if (error !== message) { error = message; emit(); }
      return;
    }
    if (!same(ids, next)) {
      ids = next;
      generation += 1;
      override = null;
      selected = ids.includes(selected) ? selected : ids[0] ?? null;
      data = new Map([...data].filter(([id]) => ids.includes(id)));
      error = '';
      emit();
      if (ids.length) await refresh();
      return;
    }
    if (ids.length && now() - lastFetchAt >= refreshMs) await refresh();
  }

  function select(delta) {
    if (closed) return false;
    const index = ids.indexOf(selected);
    if (index < 0 || !ids.length) return false;
    const next = ids[Math.max(0, Math.min(ids.length - 1, index + delta))];
    if (next === selected) return false;
    selected = next;
    override = null;
    emit();
    return true;
  }

  async function deliver(identifier) {
    if (closed) return;
    if (selected === identifier && data.has(identifier)) return;
    selected = identifier;
    override = ids.includes(identifier) ? null : identifier;
    emit();
    if (data.has(identifier)) return;
    const current = generation;
    let key = '';
    try {
      const config = load(configDir, checkout, process.env, identifier);
      key = config.linearApiKey;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      let issue;
      try { issue = await fetchOne(config, identifier, (url, options) => fetchFn(url, { ...options, signal: controller.signal })); }
      finally { clearTimeout(timeout); }
      if (closed || (current !== generation && !ids.includes(identifier))) return;
      data.set(identifier, issue);
      error = '';
      emit();
    } catch (cause) {
      if (closed || current !== generation) return;
      error = `Linear: ${shortError(cause, key)}`;
      emit();
    }
  }

  return {
    poll, select, deliver, view,
    start() { if (!closed && timer === null) { void poll(); timer = setTimer(() => { void poll(); }, pollMs); } },
    close() { closed = true; if (timer !== null) clearTimer(timer); timer = null; },
  };
}
