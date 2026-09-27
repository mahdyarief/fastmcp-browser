import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

const CLI_PATH = fileURLToPath(new URL('../dist/src/cli.js', import.meta.url));

let nextPort = 21000 + (process.pid % 1000) * 10;

type RunResult = { code: number; stdout: string; stderr: string };

function runCli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI_PATH, ...args],
      { env: { ...process.env, ...env }, timeout: 30000 },
      (err, stdout, stderr) => {
        if (err && typeof (err as { code?: unknown }).code === 'number') {
          resolve({ code: (err as { code: number }).code, stdout, stderr });
        } else if (err) {
          reject(err);
        } else {
          resolve({ code: 0, stdout, stderr });
        }
      }
    );
  });
}

type CallMessage = { type: string; id: string; method: string; params: Record<string, unknown> };

async function startHost(
  port: number,
  token: string,
  onCall: (socket: WebSocket, message: CallMessage) => void,
  seen?: { handshake?: Record<string, unknown> }
): Promise<WebSocketServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  wss.on('connection', (socket: WebSocket) => {
    let authed = false;
    socket.on('message', (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (!authed) {
        if (message.type === 'handshake' && message.token === token) {
          authed = true;
          if (seen) seen.handshake = message;
          socket.send(JSON.stringify({ type: 'handshake_ok', protocolVersion: 1 }));
        } else {
          socket.close(1008, 'unauthorized');
        }
        return;
      }
      onCall(socket, message as CallMessage);
    });
  });
  return wss;
}

async function closeHost(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}

test('cli relays a tool call and prints structured JSON', async () => {
  const port = nextPort++;
  const seen: { handshake?: Record<string, unknown> } = {};
  const wss = await startHost(
    port,
    'test-token',
    (socket, message) => {
      socket.send(JSON.stringify({ id: message.id, ok: true, result: { tabs: [1] } }));
    },
    seen
  );
  try {
    const { code, stdout, stderr } = await runCli(['browser_tabs', '{"full":true}'], {
      FASTMCP_PORT: String(port),
      FASTMCP_TOKEN: 'test-token'
    });
    assert.equal(code, 0);
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), { ok: true, result: { tabs: [1] } });
    assert.equal(seen.handshake?.role, 'peer');
  } finally {
    await closeHost(wss);
  }
});

test('cli surfaces a host error result with a nonzero exit', async () => {
  const port = nextPort++;
  const wss = await startHost(port, 'test-token', (socket, message) => {
    socket.send(
      JSON.stringify({
        id: message.id,
        ok: false,
        error: { code: 'TAB_NOT_ACCESSIBLE', message: 'tab is gone', retryable: true }
      })
    );
  });
  try {
    const { code, stdout, stderr } = await runCli(['browser_tabs'], {
      FASTMCP_PORT: String(port),
      FASTMCP_TOKEN: 'test-token'
    });
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.deepEqual(JSON.parse(stderr), {
      ok: false,
      error: { code: 'TAB_NOT_ACCESSIBLE', message: 'tab is gone', retryable: true }
    });
  } finally {
    await closeHost(wss);
  }
});

test('cli reports refusal when the token is wrong', async () => {
  const port = nextPort++;
  const wss = await startHost(port, 'test-token', () => {});
  try {
    const { code, stderr } = await runCli(['browser_status'], {
      FASTMCP_PORT: String(port),
      FASTMCP_TOKEN: 'wrong-token'
    });
    assert.equal(code, 1);
    assert.equal(JSON.parse(stderr).error.code, 'PERMISSION_DENIED');
  } finally {
    await closeHost(wss);
  }
});

test('cli reports a closed connection when no host listens', async () => {
  const port = nextPort++;
  const { code, stderr } = await runCli(['browser_status'], {
    FASTMCP_PORT: String(port),
    FASTMCP_TOKEN: 'test-token'
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(stderr).error.code, 'NO_CONNECTION');
});

test('cli times out a hung host', async () => {
  const port = nextPort++;
  const wss = await startHost(port, 'test-token', () => {
    // Never respond.
  });
  try {
    const { code, stderr } = await runCli(['browser_tabs'], {
      FASTMCP_PORT: String(port),
      FASTMCP_TOKEN: 'test-token',
      FASTMCP_CLI_TIMEOUT_MS: '300'
    });
    assert.equal(code, 1);
    assert.equal(JSON.parse(stderr).error.code, 'ACTION_TIMEOUT');
  } finally {
    await closeHost(wss);
  }
});

test('cli rejects unknown tools without connecting', async () => {
  const { code, stderr } = await runCli(['browser_nope'], {
    FASTMCP_PORT: String(nextPort++)
  });
  assert.equal(code, 1);
  const body = JSON.parse(stderr);
  assert.equal(body.error.code, 'INVALID_ARGUMENT');
  assert.match(body.error.message, /Unknown tool/);
});

test('cli rejects invalid JSON without connecting', async () => {
  const { code, stderr } = await runCli(['browser_tabs', '{oops'], {
    FASTMCP_PORT: String(nextPort++)
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(stderr).error.code, 'INVALID_ARGUMENT');
});

test('cli rejects a non-object payload without connecting', async () => {
  const { code, stderr } = await runCli(['browser_tabs', '[1,2]'], {
    FASTMCP_PORT: String(nextPort++)
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(stderr).error.code, 'INVALID_ARGUMENT');
});

test('cli --help exits zero with usage on stdout', async () => {
  const { code, stdout, stderr } = await runCli(['--help']);
  assert.equal(code, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /Usage: node dist\/src\/cli\.js/);
});
