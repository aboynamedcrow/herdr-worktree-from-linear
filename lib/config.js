import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRepo } from './repo.js';
import { parseIdentifier } from './linear.js';

const DEFAULTS = { issueLimit: 50, base: 'default', fzfLayout: 'down', showIssueDetails: false };

function apiKeyEnvName(config, repoRoot, identifier) {
  // An issue's team is explicit context; do not infer its workspace from Git.
  // Once a team map is configured, unknown teams fail rather than trying keys.
  if (identifier && config.linearApiKeyEnvByTeam !== undefined) {
    const issue = parseIdentifier(String(identifier).trim());
    if (!issue) throw new Error('worktree-from-linear: invalid issue identifier');
    const team = issue.teamKey.toUpperCase();
    const map = config.linearApiKeyEnvByTeam;
    const name = map && !Array.isArray(map) && Object.hasOwn(map, team) ? map[team] : null;
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`worktree-from-linear: configure issue team routing for ${team} in linearApiKeyEnvByTeam`);
    }
    return name;
  }
  const hasRepoRouting = config.linearApiKeyEnvByPath !== undefined
    || config.linearApiKeyEnvDefault !== undefined;
  if (!hasRepoRouting) return 'LINEAR_API_KEY';

  if (repoRoot === undefined) {
    try {
      ({ repoRoot } = resolveRepo({ PWD: process.cwd() }));
    } catch {
      // Callers such as the issue-details pane may run without a resolvable repo.
      // In that case no path rule matches and the configured default is used.
      repoRoot = undefined;
    }
  }

  const normalizedRoot = typeof repoRoot === 'string' ? repoRoot.toLowerCase() : null;
  const rules = Array.isArray(config.linearApiKeyEnvByPath) ? config.linearApiKeyEnvByPath : [];
  const match = rules.find((rule) => (
    rule
    && normalizedRoot !== null
    && typeof rule.contains === 'string'
    && typeof rule.env === 'string'
    && normalizedRoot.includes(rule.contains.toLowerCase())
  ));
  return match?.env || config.linearApiKeyEnvDefault;
}

export function loadConfig(configDir, repoRoot, env = process.env, identifier = '') {
  let parsed = {};
  if (configDir) {
    let text = null;
    try {
      text = readFileSync(join(configDir, 'config.json'), 'utf8');
    } catch {
      text = null;
    }
    if (text !== null) {
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw new Error(`worktree-from-linear: invalid config.json: ${err.message}`);
      }
    }
  }
  const config = { ...DEFAULTS, ...parsed };
  const envName = apiKeyEnvName(config, repoRoot, identifier);
  const linearApiKey = config.linearApiKey
    || (typeof envName === 'string' && envName ? env[envName] : undefined);
  if (typeof linearApiKey !== 'string' || !linearApiKey) {
    const environment = typeof envName === 'string' && envName
      ? envName
      : 'configured Linear API key';
    throw new Error(
      `worktree-from-linear: set linearApiKey in config.json or the ${environment} environment variable (Linear personal API key)`
    );
  }
  return { ...config, linearApiKey };
}
