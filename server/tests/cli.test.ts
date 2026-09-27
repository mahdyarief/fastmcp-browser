import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
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

type CallMessage = { type: string; id: string; method?: string; name?: string; params: Record<string, unknown> };

async function startHost(
  port: number,
  token: string,
  onCall: (socket: WebSocket, message: CallMessage) => void,
  seen?: { handshake?: Record<string, unknown> },
  instances: Array<{ id: string; active: boolean }> = []
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
          socket.send(JSON.stringify({ type: 'handshake_ok', protocolVersion: 1, instances }));
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

test('cli serves browser_instances from the handshake snapshot without a call', async () => {
  const port = nextPort++;
  const instances = [{ id: 'instance-a', active: true }];
  let callCount = 0;
  const wss = await startHost(port, 'test-token', () => { callCount += 1; }, undefined, instances);
  try {
    const { code, stdout, stderr } = await runCli(['browser_instances'], {
      FASTMCP_PORT: String(port),
      FASTMCP_TOKEN: 'test-token'
    });
    assert.equal(code, 0);
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), { ok: true, result: instances });
    assert.equal(callCount, 0, 'browser_instances must not be relayed as a bridge call');
  } finally {
    await closeHost(wss);
  }
});

test('cli sends browser_use_instance as a bridge_call use_instance message', async () => {
  const port = nextPort++;
  const seenMessages: CallMessage[] = [];
  const wss = await startHost(port, 'test-token', (socket, message) => {
    seenMessages.push(message);
    if (message.type === 'bridge_call' && message.name === 'use_instance') {
      socket.send(JSON.stringify({ id: message.id, ok: true, result: { active: 'instance-a' } }));
      return;
    }
    socket.send(JSON.stringify({ id: message.id, ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Expected a bridge_call', retryable: false } }));
  });
  try {
    const { code, stdout } = await runCli(['browser_use_instance', '{"id":"instance-a"}'], {
      FASTMCP_PORT: String(port),
      FASTMCP_TOKEN: 'test-token'
    });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout), { ok: true, result: { active: 'instance-a' } });
    assert.equal(seenMessages.length, 1);
    assert.equal(seenMessages[0].type, 'bridge_call');
    assert.equal(seenMessages[0].name, 'use_instance');
    assert.deepEqual(seenMessages[0].params, { id: 'instance-a' });
  } finally {
    await closeHost(wss);
  }
});

test('cli rejects browser_use_instance without a string id', async () => {
  const { code, stderr } = await runCli(['browser_use_instance', '{}'], {
    FASTMCP_PORT: String(nextPort++)
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(stderr).error.code, 'INVALID_ARGUMENT');
});

test('cli hydrates browser_upload paths into files before calling the host', async () => {
  const port = nextPort++;
  const seenMessages: CallMessage[] = [];
  const wss = await startHost(port, 'test-token', (socket, message) => {
    seenMessages.push(message);
    socket.send(JSON.stringify({ id: message.id, ok: true, result: { uploaded: true } }));
  });
  const tmpFile = fileURLToPath(new URL('./upload-fixture.txt', import.meta.url));
  await writeFile(tmpFile, 'hello upload');
  try {
    const { code, stdout } = await runCli(['browser_upload', `{"paths":${JSON.stringify([tmpFile])}}`], {
      FASTMCP_PORT: String(port),
      FASTMCP_TOKEN: 'test-token'
    });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout), { ok: true, result: { uploaded: true } });
    assert.equal(seenMessages.length, 1);
    const params = seenMessages[0].params as Record<string, unknown>;
    assert.ok(!('paths' in params), 'raw paths must not be forwarded');
    assert.ok(Array.isArray(params.files) && (params.files as unknown[]).length === 1);
    const file = (params.files as Array<Record<string, unknown>>)[0];
    assert.equal(file.name, 'upload-fixture.txt');
    assert.equal(file.data, Buffer.from('hello upload').toString('base64'));
  } finally {
    await rm(tmpFile, { force: true });
    await closeHost(wss);
  }
});

test('cli rejects browser_upload with missing files without connecting', async () => {
  const { code, stderr } = await runCli(['browser_upload', '{"paths":["/no/such/file-xyz.txt"]}'], {
    FASTMCP_PORT: String(nextPort++)
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(stderr).error.code, 'INVALID_ARGUMENT');
});

test('cli rejects browser_upload without a paths array without connecting', async () => {
  const { code, stderr } = await runCli(['browser_upload', '{}'], {
    FASTMCP_PORT: String(nextPort++)
  });
  assert.equal(code, 1);
  assert.equal(JSON.parse(stderr).error.code, 'INVALID_ARGUMENT');
});

test('cli returns structured JSON when the TCP peer never speaks WebSocket', async () => {
  const { createServer } = await import('node:net');
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((socket) => {
    // Accept and hold the connection without speaking HTTP/WebSocket.
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  const port = nextPort++;
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  try {
    const { code, stdout, stderr } = await runCli(['browser_status'], {
      FASTMCP_PORT: String(port),
      FASTMCP_CLI_TIMEOUT_MS: '1500'
    });
    assert.equal(code, 1);
    assert.equal(stdout, '');
    const parsed = JSON.parse(stderr);
    assert.equal(parsed.ok, false);
    assert.equal(typeof parsed.error.code, 'string');
    assert.equal(typeof parsed.error.message, 'string');
    assert.doesNotMatch(stderr, /node:events/);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
