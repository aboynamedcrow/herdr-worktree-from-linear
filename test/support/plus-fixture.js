import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Synthetic command replies with a real executable path: discovery verifies the
// registered plugin's filesystem boundary even when commands are mocked.
export function plusFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wfl-plus-')));
  mkdirSync(join(root, 'bin'));
  const binary = join(root, 'bin', 'herdr-plus');
  writeFileSync(binary, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const plan = { version: 1, fingerprint: 'a'.repeat(64), project: 'fixture', repository: '/repo', issue: 'BIT-1',
    candidates: [{ id: 'b'.repeat(64), branch: 'ingwon/bit-1-do-it', path: '/wt/bit-1', existing: false, checkout: false }] };
  const output = JSON.stringify({ result: { workspace: { workspace_id: 'w9' }, worktree: { branch: plan.candidates[0].branch, path: plan.candidates[0].path } } });
  const ok = (stdout) => ({ status: 0, stdout, stderr: '' });
  return { root, binary, plan, output, close: () => rmSync(root, { recursive: true, force: true }),
    reply(cmd, args, opts, overrides = {}) {
      if (cmd === 'herdr' && args[0] === 'plugin' && args[1] === 'list') return ok(JSON.stringify({ result: { plugins: [{ plugin_id: 'cloudmanic.herdr-plus', enabled: true, plugin_root: root }] } }));
      if (cmd === 'herdr' && args[0] === 'plugin' && args[1] === 'config-dir') return ok('/plus-config\n');
      if (cmd === binary && args[0] === 'plan-worktree') return ok(JSON.stringify({ ...plan, candidates: plan.candidates.map((c) => ({ ...c, existing: !!overrides.checkout, checkout: !!overrides.checkout })) }));
      if (cmd === binary && args[0] === 'apply-worktree') return ok(overrides.output || output);
      return null;
    },
  };
}
