/**
 * nc — chat with your FrontLane agent from the terminal.
 *
 * Usage:
 *   pnpm run chat <message...>
 *   pnpm run chat --as user-1 --name "User 1" <message...>
 *
 * Sends the message through the CLI channel (Unix socket) to the wired agent.
 * Reads replies until the stream goes quiet, then exits.
 *
 * `--as` / `--name` simulate a different sender identity (namespaced as
 * `cli:<id>` by the permissions module). Use this to test per-user session
 * isolation without a second platform account.
 *
 * Preconditions: FrontLane host service running, an agent group wired to
 * `cli/local` via `/init-first-agent` or `/manage-channels`.
 */
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../src/config.js';

const SILENCE_MS = 2000; // exit after this much quiet time following the first reply
const TOTAL_TIMEOUT_MS = 120_000; // hard stop

function socketPath(): string {
  return path.join(DATA_DIR, 'cli.sock');
}

interface ChatOpts {
  text: string;
  senderId?: string;
  senderName?: string;
}

function parseArgs(argv: string[]): ChatOpts {
  let senderId: string | undefined;
  let senderName: string | undefined;
  const words: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--as') {
      senderId = argv[++i];
      if (!senderId) {
        console.error('usage: --as requires a sender id (e.g. user-1)');
        process.exit(1);
      }
      continue;
    }
    if (arg === '--name') {
      senderName = argv[++i];
      if (!senderName) {
        console.error('usage: --name requires a display name');
        process.exit(1);
      }
      continue;
    }
    words.push(arg);
  }

  if (words.length === 0) {
    console.error('usage: pnpm run chat [--as <id>] [--name <display>] <message...>');
    process.exit(1);
  }

  return { text: words.join(' '), senderId, senderName };
}

function main(): void {
  const { text, senderId, senderName } = parseArgs(process.argv.slice(2));

  const socket = net.connect(socketPath());

  socket.on('error', (err) => {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
      console.error(`FrontLane daemon not reachable at ${socketPath()}.`);
      console.error('Start the service (launchctl/systemd) before running nc.');
    } else {
      console.error('CLI socket error:', err);
    }
    process.exit(2);
  });

  let firstReplySeen = false;
  let silenceTimer: NodeJS.Timeout | null = null;
  let hardTimer: NodeJS.Timeout | null = null;

  function scheduleExit(): void {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      socket.end();
      process.exit(0);
    }, SILENCE_MS);
  }

  socket.on('connect', () => {
    const payload: Record<string, string> = { text };
    if (senderId) payload.senderId = senderId;
    if (senderName) payload.sender = senderName;
    socket.write(JSON.stringify(payload) + '\n');
    hardTimer = setTimeout(() => {
      if (!firstReplySeen) {
        console.error(`timeout: no reply in ${TOTAL_TIMEOUT_MS}ms`);
        socket.end();
        process.exit(3);
      }
    }, TOTAL_TIMEOUT_MS);
  });

  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (typeof msg.text === 'string') {
          process.stdout.write(msg.text + '\n');
          firstReplySeen = true;
          if (hardTimer) {
            clearTimeout(hardTimer);
            hardTimer = null;
          }
          scheduleExit();
        }
      } catch {
        // Ignore non-JSON lines — forward compatibility.
      }
    }
  });

  socket.on('close', () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    if (hardTimer) clearTimeout(hardTimer);
    process.exit(firstReplySeen ? 0 : 3);
  });
}

main();
