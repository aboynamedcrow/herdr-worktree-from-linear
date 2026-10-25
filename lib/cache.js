import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';

// Observe the key name that config selects. Do not duplicate its routing rules.
// An inline key does not read the environment, so it keeps the fixed name.
export function loadListConfig(configDir, repoRoot, env) {
  let workspace = 'inline';
  const config = loadConfig(configDir, repoRoot, new Proxy(env, {
    get(target, name) { workspace = name; return target[name]; },
  }));
  return { config, workspace };
}

const fields = ['identifier', 'title', 'createdAt', 'branchName', 'url', 'stateName', 'stateType', 'stateColor', 'project', 'assignee', 'teamKey'];
const rowsOnly = (rows) => rows.map((row) => Object.fromEntries(fields.map((field) => [field, String(row[field] ?? '')])));
const fingerprint = (config) => JSON.stringify({ teamKey: config.teamKey || '', assignedToMe: Boolean(config.assignedToMe),
  includeTriage: Boolean(config.includeTriage), recentDoneHours: config.recentDoneHours, issueLimit: config.issueLimit });

export function cachedHeader(fetchedAt, now = Date.now) {
  return Number.isFinite(fetchedAt)
    ? `cached ${Math.max(0, Math.floor((now() - fetchedAt) / 60000))}m ago` : 'refreshing';
}

export function issueCache(config, { env, workspace, now = Date.now, warn = () => {} }) {
  const directory = env.HOME && join(env.HOME, '.cache', 'herdr-worktree-from-linear');
  const path = directory && typeof workspace === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(workspace)
    ? join(directory, `${workspace}.json`) : null;
  return {
    path,
    read() {
      if (!path) return null;
      try {
        chmodSync(directory, 0o700);
        chmodSync(path, 0o600);
        const data = JSON.parse(readFileSync(path, 'utf8'));
        if (data.version !== 2 || data.filter !== fingerprint(config) || !Array.isArray(data.rows)
            || data.rows.some((row) => !row || typeof row.identifier !== 'string' || typeof row.title !== 'string')) return null;
        return { rows: rowsOnly(data.rows), fetchedAt: Number.isFinite(data.fetchedAt) ? data.fetchedAt : null };
      } catch { return null; }
    },
    write(rows) {
      if (!path) return;
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        chmodSync(directory, 0o700);
        writeFileSync(temporary, JSON.stringify({ version: 2, filter: fingerprint(config), fetchedAt: now(), rows: rowsOnly(rows) }),
          { mode: 0o600, flag: 'wx' });
        renameSync(temporary, path);
      } catch {
        warn('worktree-from-linear: could not write the issue cache');
      } finally { try { rmSync(temporary, { force: true }); } catch { /* The cache is optional. */ } }
    },
  };
}
