import { spawnSync } from 'node:child_process';

export function listKeyAction(key) {
  if (key === 0x6a) return 'next';
  if (key === 0x6b) return 'previous';
  if (key === 0x0d || key === 0x0a) return 'full';
  if (key === 0x6f) return 'open';
  if (key === 0x71 || key === 0x03 || key === 0x04) return 'quit';
  return null;
}

export function openInLinear(issue, { run = spawnSync, platform = process.platform } = {}) {
  const url = issue?.url;
  if (typeof url !== 'string' || !/^https:\/\/linear\.app\//.test(url)) return false;
  const command = platform === 'darwin' ? 'open' : 'xdg-open';
  return run(command, [url], { timeout: 5000, stdio: 'ignore' }).status === 0;
}
