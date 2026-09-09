import { spawnSync } from 'node:child_process';

// Every command this plugin runs is a child process it waits for, so every one of them
// needs a bound. `timeout` is enforced by spawnSync itself — a timer around a synchronous
// call cannot interrupt it — and the child is signalled, not left running: without this a
// stalled `herdr` would hold the picker open indefinitely.
export function runCmd(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', killSignal: 'SIGKILL', ...opts });
  const timedOut = res.error?.code === 'ETIMEDOUT';
  // A killed child's own stderr is usually empty, so say why it has nothing to say.
  const stderr = String(res.stderr ?? '')
    || (timedOut ? `timed out after ${opts.timeout}ms` : '')
    || (res.error ? String(res.error.message) : '');
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr,
    timedOut,
  };
}
