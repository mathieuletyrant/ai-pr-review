import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SANDBOX_PORT = 8787;
const STOP_POLL_MS = 250;
const SELF = fileURLToPath(import.meta.url);
const LOOPBACK_UP = `import fcntl, socket, struct
fcntl.ioctl(socket.socket(), 0x8914, struct.pack('16sH', b'lo', 0x41))`;

/**
 * The command that runs `command` where it reaches nothing but the checkout: in a network namespace holding only a
 * loopback, whose port `SANDBOX_PORT` leads to the meter listening on the Unix socket `meterSocket`; in a process
 * namespace of its own, so `/proc` shows no process of the job; as `uid` and `gid` with no other group and no new
 * privilege, so neither `sudo` nor the Docker socket answers. `envFile` holds the environment `command` runs in, as
 * JSON. The namespaces need root: `sudo -n` gives it unless the caller is root already. A signal may stop at `sudo`,
 * so the sandbox also ends, with every process in it, once the file `stopFileOf(envFile)` exists.
 */
export function sandboxed({ command, envFile, meterSocket, uid, gid, isRoot = process.getuid() === 0 }) {
  const enter = [
    'unshare',
    '--net',
    '--pid',
    '--fork',
    '--kill-child',
    '--mount-proc',
    '--',
    process.execPath,
    SELF,
    String(uid),
    String(gid),
    meterSocket,
    envFile,
    '--',
    ...command,
  ];
  return isRoot ? enter : ['sudo', '-n', ...enter];
}

/** The file whose creation ends the sandbox started with `envFile`. */
export const stopFileOf = (envFile) => join(dirname(envFile), 'stop');

function bringLoopbackUp() {
  try {
    execFileSync('ip', ['link', 'set', 'lo', 'up'], { stdio: 'ignore' });
  } catch {
    execFileSync('python3', ['-c', LOOPBACK_UP], { stdio: 'ignore' });
  }
}

function bridgeToMeter(meterSocket) {
  const server = createServer((client) => {
    const meter = connect(meterSocket);
    client.pipe(meter).pipe(client);
    client.on('error', () => meter.destroy());
    meter.on('error', () => client.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(SANDBOX_PORT, '127.0.0.1', resolve);
  });
}

async function main() {
  const separator = process.argv.indexOf('--');
  const [uid, gid, meterSocket, envFile] = process.argv.slice(2, separator);
  const [bin, ...args] = process.argv.slice(separator + 1);
  process.on('SIGTERM', () => process.exit(143));
  process.on('SIGINT', () => process.exit(130));
  setInterval(() => existsSync(stopFileOf(envFile)) && process.exit(143), STOP_POLL_MS).unref();
  bringLoopbackUp();
  await bridgeToMeter(meterSocket);
  const child = spawn(
    'setpriv',
    [`--reuid=${uid}`, `--regid=${gid}`, '--clear-groups', '--no-new-privs', '--inh-caps=-all', '--', bin, ...args],
    { env: JSON.parse(readFileSync(envFile, 'utf8')), stdio: 'inherit' },
  );
  child.on('error', (error) => {
    console.error(`sandbox: ${error.message}`);
    process.exit(126);
  });
  child.on('close', (code, signal) => process.exit(code ?? (signal ? 137 : 1)));
}

if (process.argv[1] === SELF) {
  main().catch((error) => {
    console.error(`sandbox: ${error.message}`);
    process.exit(126);
  });
}
