import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('manifest registers the show action and version 0.6.0', () => {
  const manifest = readFileSync(new URL('../herdr-plugin.toml', import.meta.url), 'utf8');
  const action = manifest.split('[[actions]]').find((entry) => /^id = "show"$/m.test(entry));
  assert.ok(action);
  assert.match(action, /^title = "Show Linear issue here"$/m);
  assert.match(action, /^contexts = \["workspace", "tab", "pane"\]$/m);
  assert.match(action, /^command = \["node", "bin\/open.js", "--show"\]$/m);
  assert.match(manifest, /^version = "0.6.0"$/m);
  assert.equal(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version, '0.6.0');
});
