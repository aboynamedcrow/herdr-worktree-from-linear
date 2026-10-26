import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('all actions and panes load both routes without a login shell', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'linear-route-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'dot', 'bin'), { recursive: true });
  writeFileSync(join(home, 'dot', 'bin', 'agent-service-env'), `#!/bin/sh
[ "$1 $2 $3 $4" = 'run --inherit linear-ember,linear-hsys --' ] || exit 91
shift 4
[ -z "$LINEAR_API_KEY_EMBER" ] && [ -z "$LINEAR_API_KEY_HSYS" ] || exit 92
export LINEAR_API_KEY_EMBER=synthetic-linear-ember
export LINEAR_API_KEY_HSYS=synthetic-linear-hsys
exec "$@"
`, { mode: 0o700 });
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'node'), `#!/bin/sh
[ "$LINEAR_API_KEY_EMBER" = synthetic-linear-ember ] || exit 93
[ "$LINEAR_API_KEY_HSYS" = synthetic-linear-hsys ] || exit 94
[ "$HERDR_PANE_ID" = w1:p1 ] || exit 95
printf '%s\\n' "$@"
`, { mode: 0o700 });
  const manifest = readFileSync(new URL('../herdr-plugin.toml', import.meta.url), 'utf8');
  const commands = [...manifest.matchAll(/^command = (.+)$/gm)].map((m) => JSON.parse(m[1]));
  assert.equal(commands.length, 5);
  for (const command of commands) {
    assert.deepEqual(command.slice(0, 2), ['sh', '-c']);
    const result = spawnSync(command[0], command.slice(1), {
      cwd: new URL('..', import.meta.url),
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, HERDR_PANE_ID: 'w1:p1' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), command.slice(5));
    assert.equal((result.stdout + result.stderr).includes('synthetic-linear'), false);
  }
});
