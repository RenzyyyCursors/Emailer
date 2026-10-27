import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSmtpProbe, isPublicAddress } from '../src/smtp.js';

const EMAIL = 'owned@example.com';
const PUBLIC_IP = '93.184.216.34';

class MockSocket extends EventEmitter {
  constructor({ greeting = '220 mail.example ESMTP\r\n', replies = {}, stallAt, chunks = false } = {}) {
    super();
    this.commands = [];
    this.destroyed = false;
    this.writable = true;
    this.replies = replies;
    this.stallAt = stallAt;
    this.chunks = chunks;
    queueMicrotask(() => this.respond(greeting));
  }

  respond(response) {
    if (this.destroyed || response === undefined) return;
    if (this.chunks) {
      for (let i = 0; i < response.length; i += 7) this.emit('data', Buffer.from(response.slice(i, i + 7)));
    } else this.emit('data', Buffer.from(response));
  }

  write(value) {
    this.commands.push(value);
    const line = value.trim();
    if (line === this.stallAt) return true;
    const response = this.replies[line] ?? (line.startsWith('EHLO ') ? '250 mail.example\r\n'
      : line.startsWith('HELO ') ? '250 mail.example\r\n'
        : line === 'MAIL FROM:<>' ? '250 sender accepted\r\n'
          : line.startsWith('RCPT TO:') ? '250 recipient accepted\r\n'
            : '221 bye\r\n');
    queueMicrotask(() => this.respond(response));
    return true;
  }

  end() { this.writable = false; }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
  }
}

function setup(socketOptions = {}, probeOptions = {}) {
  let socket;
  let connectionOptions;
  const probe = createSmtpProbe({
    allowedEmails: [EMAIL],
    resolveHost: async () => [{ address: PUBLIC_IP, family: 4 }],
    socketFactory: (options) => {
      connectionOptions = options;
      socket = new MockSocket(socketOptions);
      return socket;
    },
    ...probeOptions,
  });
  return { probe, get socket() { return socket; }, get connectionOptions() { return connectionOptions; } };
}

test('requires exact operator-owned address before DNS lookup or SMTP connection', async () => {
  let called = false;
  const probe = createSmtpProbe({
    allowedEmails: [EMAIL],
    resolveHost: () => { called = true; throw new Error('Must not resolve'); },
  });
  for (const email of ['other@example.com', 'Owned@example.com', '*@example.com', ` ${EMAIL}`]) {
    assert.equal((await probe(email, 'mx.example.com')).status, 'unknown');
  }
  assert.equal(called, false);
});

test('accepts a recipient envelope without sending DATA or a message', async () => {
  const session = setup();
  const result = await session.probe(EMAIL, [{ host: 'mx.example.com', priority: 10 }]);
  assert.equal(result.status, 'accepted');
  assert.match(result.reason, /not guaranteed.*catch-all.*untested/);
  assert.deepEqual(session.connectionOptions, { host: PUBLIC_IP, family: 4, port: 25 });
  assert.deepEqual(session.socket.commands, [
    'EHLO localhost\r\n', 'MAIL FROM:<>\r\n', `RCPT TO:<${EMAIL}>\r\n`, 'QUIT\r\n',
  ]);
  assert.equal(session.socket.destroyed, true);
});

test('supports 251 recipient acceptance', async () => {
  const session = setup({ replies: { [`RCPT TO:<${EMAIL}>`]: '251 2.1.5 will forward\r\n' } });
  assert.equal((await session.probe(EMAIL, 'mx.example.com')).status, 'accepted');
});

test('definitively rejects only 550 with an explicit 5.1.1 enhanced status', async () => {
  const session = setup({ replies: { [`RCPT TO:<${EMAIL}>`]: '550 5.1.1 mailbox does not exist\r\n' } });
  assert.deepEqual(await session.probe(EMAIL, { exchange: 'mx.example.com.' }), {
    status: 'rejected', definitive: true,
    reason: 'SMTP server explicitly rejected the recipient with 550 5.1.1 (mailbox does not exist).',
  });
});

test('treats policy rejection, temporary failures, ambiguous rejection and 252 as unknown', async () => {
  for (const response of ['550 5.7.1 blocked by policy', '550 mailbox unavailable', '550 5.1.10 recipient disabled', '450 4.2.0 try again', '421 server busy', '252 cannot verify recipient', '551 5.1.1 user not local']) {
    const session = setup({ replies: { [`RCPT TO:<${EMAIL}>`]: `${response}\r\n` } });
    const result = await session.probe(EMAIL, 'mx.example.com');
    assert.equal(result.status, 'unknown', response);
    assert.equal(result.definitive, undefined);
  }
});

test('parses chunked multiline replies and falls back from EHLO to HELO', async () => {
  const session = setup({ chunks: true, replies: {
    'EHLO localhost': '502 command unrecognized\r\n',
    'HELO localhost': '250-mail.example\r\n250 hello\r\n',
  } });
  assert.equal((await session.probe(EMAIL, 'mx.example.com')).status, 'accepted');
  assert.equal(session.socket.commands[1], 'HELO localhost\r\n');
});

test('uses lowest-priority MX and pins its validated DNS address', async () => {
  let resolvedHost;
  const session = setup({}, { resolveHost: async (host) => {
    resolvedHost = host;
    return [{ address: '2606:4700:4700::1111', family: 6 }];
  } });
  assert.equal((await session.probe(EMAIL, [
    { host: 'secondary.example.com', priority: 20 }, { host: 'primary.example.com', priority: 10 },
  ])).status, 'accepted');
  assert.equal(resolvedHost, 'primary.example.com');
  assert.deepEqual(session.connectionOptions, { host: '2606:4700:4700::1111', family: 6, port: 25 });
});

test('blocks all private, loopback, local, multicast and special-purpose addresses', () => {
  const blocked = ['0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.0.1', '100.64.0.1', '100.127.255.255', '192.0.0.1', '192.0.2.5', '192.88.99.1', '198.18.0.1', '198.19.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fe80::1', 'fe80::1%en0', 'fc00::1', 'fd00::1', 'ff02::1', '64:ff9b::a00:1', '2001:db8::1', '2001::1', '2001:2::1', '2002:a00:1::', '3fff::1', '3fff:fff::1', 'localhost', '2130706433'];
  for (const address of blocked) assert.equal(isPublicAddress(address), false, address);
  for (const address of [PUBLIC_IP, '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test('rejects mixed DNS answers before opening a socket', async () => {
  const session = setup({}, { resolveHost: async () => [{ address: PUBLIC_IP }, { address: '127.0.0.1' }] });
  const result = await session.probe(EMAIL, 'mx.example.com');
  assert.equal(result.status, 'unknown');
  assert.match(result.reason, /private or special-purpose/);
  assert.equal(session.socket, undefined);
});

test('rejects invalid MX names, empty DNS answers, unsafe addresses and CRLF injection', async () => {
  const invalid = setup();
  assert.equal((await invalid.probe(EMAIL, 'mx.example.com\r\nDATA')).status, 'unknown');
  assert.equal(invalid.socket, undefined);
  const empty = setup({}, { resolveHost: async () => [] });
  assert.equal((await empty.probe(EMAIL, 'mx.example.com')).status, 'unknown');
  assert.equal(empty.socket, undefined);
  const maliciousEmail = 'owned@example.com>\r\nDATA';
  const injected = setup({}, { allowedEmails: [maliciousEmail] });
  assert.equal((await injected.probe(maliciousEmail, 'mx.example.com')).status, 'unknown');
  assert.equal(injected.socket, undefined);
});

test('bounds total SMTP time and closes a stalled socket', async () => {
  const session = setup({ stallAt: `RCPT TO:<${EMAIL}>` }, { timeoutMs: 100 });
  const started = Date.now();
  const result = await session.probe(EMAIL, 'mx.example.com');
  assert.equal(result.status, 'unknown');
  assert.match(result.reason, /timed out|failed/);
  assert.ok(Date.now() - started < 1000);
  assert.equal(session.socket.destroyed, true);
});

test('bounds a stalled DNS resolution and never connects after it eventually resolves', async () => {
  let release;
  const session = setup({}, { timeoutMs: 100, resolveHost: () => new Promise((resolve) => { release = resolve; }) });
  assert.equal((await session.probe(EMAIL, 'mx.example.com')).status, 'unknown');
  release([{ address: PUBLIC_IP }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.socket, undefined);
});

test('returns unknown for malformed replies, mismatched multiline codes and oversized replies', async () => {
  for (const greeting of ['not smtp\r\n', '220-first\r\n250 wrong code\r\n', `220 ${'x'.repeat(4097)}\r\n`]) {
    const session = setup({ greeting });
    assert.equal((await session.probe(EMAIL, 'mx.example.com')).status, 'unknown');
    assert.equal(session.socket.commands.some((line) => line.startsWith('RCPT TO:')), false);
  }
});

test('does not attempt RCPT when greeting, handshake or sender is declined', async () => {
  for (const options of [
    { greeting: '421 server unavailable\r\n' },
    { replies: { 'EHLO localhost': '550 access denied\r\n' } },
    { replies: { 'MAIL FROM:<>': '550 5.7.1 sender policy\r\n' } },
  ]) {
    const session = setup(options);
    assert.equal((await session.probe(EMAIL, 'mx.example.com')).status, 'unknown');
    assert.equal(session.socket.commands.some((line) => line.startsWith('RCPT TO:')), false);
  }
});

test('validates configuration without opening connections', () => {
  for (const options of [{ heloHost: 'localhost\r\nDATA' }, { port: 0 }, { port: 65536 }, { timeoutMs: 0 }, { timeoutMs: 30001 }, { allowedEmails: '*' }]) {
    assert.throws(() => createSmtpProbe(options), TypeError);
  }
});
