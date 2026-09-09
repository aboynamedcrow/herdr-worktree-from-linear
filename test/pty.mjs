// A real pty for the tests that need one, because the behavior they check — raw mode, a
// shell blocked in a builtin, `q`, the cursor — does not exist without a terminal.
//
// python3's pty module is stdlib on macOS and Linux. This is pty.fork rather than
// pty.spawn for two reasons: the child's pid is needed (it is what the delivery driver
// inspects), and on macOS select() never reports EOF on the master once the child has put
// the tty in raw mode, so pty.spawn's copy loop outlives the child forever. Here the child
// is waited on directly instead.
import { spawnSync } from 'node:child_process';

export const PTY_WRAPPER = [
  'import os, pty, sys, select',
  'pid, fd = pty.fork()',
  'if pid == 0:',
  '    os.execv(sys.argv[1], sys.argv[1:])',
  'sys.stderr.write("CHILDPID:%d\\n" % pid)',
  'sys.stderr.flush()',
  'fds = [fd, 0]',
  'status = None',
  'while True:',
  '    r, _, _ = select.select(fds, [], [], 0.05)',
  '    if fd in r:',
  '        try:',
  '            data = os.read(fd, 4096)',
  '        except OSError:',
  '            data = b""',
  '        if data:',
  '            os.write(1, data)',
  '        else:',
  '            fds.remove(fd)',
  '    if 0 in r:',
  '        data = os.read(0, 4096)',
  '        if data:',
  '            os.write(fd, data)',
  '        else:',
  '            fds.remove(0)',
  '    done, status = os.waitpid(pid, os.WNOHANG)',
  '    if done == pid:',
  '        break',
  'try:',
  '    while True:',
  '        data = os.read(fd, 4096)',
  '        if not data:',
  '            break',
  '        os.write(1, data)',
  'except OSError:',
  '    pass',
  'raise SystemExit(os.waitstatus_to_exitcode(status))',
].join('\n');

export function ptyAvailable() {
  return spawnSync('python3', ['-c', 'import pty, os, select'], { encoding: 'utf8' }).status === 0;
}

// Wait for something a child process does asynchronously, without a fixed sleep.
export async function until(predicate, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}
