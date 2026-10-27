import net from 'node:net';
import { lookup } from 'node:dns/promises';

const MAX_REPLY_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 4096;

/** Conservative public-address check. Special-purpose and transition ranges fail closed. */
export function isPublicAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6) return false;
  // Only native global unicast 2000::/3. This excludes mapped IPv4, local,
  // unspecified, loopback, multicast, NAT64, and link-local representations.
  const halves = address.toLowerCase().split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves[1] ? halves[1].split(':') : [];
  if (head.concat(tail).some((part) => part.includes('.'))) return false;
  const words = halves.length === 2
    ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
    : head;
  const first = parseInt(words[0], 16);
  const second = parseInt(words[1], 16);
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2001 && (second < 0x0200 || second === 0x0db8)) return false;
  if (first === 0x2002) return false; // 6to4 can tunnel to a private IPv4 address.
  if (first === 0x3fff && second < 0x1000) return false; // Documentation prefix 3fff::/20.
  return true;
}

function pickHost(mx) {
  const entries = Array.isArray(mx) ? [...mx].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)) : [mx];
  const first = entries[0];
  const host = typeof first === 'string' ? first : first?.exchange ?? first?.host;
  if (typeof host !== 'string') return null;
  const normalized = host.endsWith('.') ? host.slice(0, -1) : host;
  if (normalized.length > 253 || !normalized.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null;
  return normalized;
}

function makeReplyReader(socket) {
  let pending = '';
  let total = 0;
  let current = null;
  let failure;
  const complete = [];
  const waiting = [];
  const fail = (error) => {
    failure ??= error;
    while (waiting.length) waiting.shift().reject(failure);
  };
  const onData = (data) => {
    total += data.length;
    if (total > MAX_REPLY_BYTES) return fail(new Error('SMTP response exceeds the safety limit.'));
    pending += data.toString('utf8');
    if (pending.length > MAX_LINE_BYTES && !pending.includes('\n')) return fail(new Error('SMTP response line is too long.'));
    while (pending.includes('\n') && !failure) {
      const end = pending.indexOf('\n');
      const line = pending.slice(0, end).replace(/\r$/, '');
      pending = pending.slice(end + 1);
      if (line.length > MAX_LINE_BYTES) return fail(new Error('SMTP response line is too long.'));
      const match = /^([2-5]\d\d)([ -])(.*)$/.exec(line);
      if (!match) return fail(new Error('SMTP response is malformed.'));
      const code = Number(match[1]);
      if (current && current.code !== code) return fail(new Error('SMTP multiline response is inconsistent.'));
      current ??= { code, lines: [] };
      current.lines.push(match[3]);
      if (match[2] === ' ') {
        const reply = current;
        current = null;
        const waiter = waiting.shift();
        if (waiter) waiter.resolve(reply);
        else complete.push(reply);
      }
    }
  };
  const onError = () => fail(new Error('SMTP connection failed.'));
  const onClose = () => fail(new Error('SMTP server closed the connection.'));
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);
  return {
    read() {
      if (failure) return Promise.reject(failure);
      if (complete.length) return Promise.resolve(complete.shift());
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    dispose() {
      fail(new Error('SMTP session ended.'));
      socket.off('data', onData);
      socket.off('close', onClose);
      // Keep the error handler until the socket closes, avoiding an unhandled
      // late connection error while destroy() finishes.
      socket.once('close', () => socket.off('error', onError));
    },
  };
}

/**
 * Optional local-only SMTP envelope check. No DATA, message body, random
 * recipient, or catch-all probe is ever sent. Ownership is an exact-address
 * allowlist set by the operator, not a request parameter.
 *
 * resolveHost and socketFactory exist for deterministic tests. Even an injected
 * resolver must return only public IP literals; sockets are pinned to one IP.
 */
export function createSmtpProbe({
  allowedEmails = [],
  heloHost = 'localhost',
  port = 25,
  timeoutMs = 5000,
  resolveHost = (host) => lookup(host, { all: true, verbatim: true }),
  socketFactory = (options) => net.createConnection(options),
} = {}) {
  if (!Array.isArray(allowedEmails) && !(allowedEmails instanceof Set)) throw new TypeError('allowedEmails must be an array or Set of exact addresses.');
  const allowed = new Set(allowedEmails);
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(heloHost)) throw new TypeError('heloHost must be an ASCII hostname.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('port must be between 1 and 65535.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new TypeError('timeoutMs must be between 100 and 30000.');
  if (typeof resolveHost !== 'function' || typeof socketFactory !== 'function') throw new TypeError('SMTP resolver and socket factory must be functions.');

  return async function probe(email, mx) {
    if (!allowed.has(email)) return { status: 'unknown', reason: 'SMTP check skipped: this exact address is not in the operator ownership allowlist.' };
    if (typeof email !== 'string' || email.length > 254 || !/^[\x21-\x7e]+@[a-z0-9.-]+$/i.test(email) || /[<>\r\n]/.test(email) || email.indexOf('@') !== email.lastIndexOf('@')) {
      return { status: 'unknown', reason: 'SMTP check skipped: address cannot be represented safely without SMTPUTF8.' };
    }
    const host = pickHost(mx);
    if (!host) return { status: 'unknown', reason: 'SMTP check skipped: no usable mail exchanger hostname.' };

    let socket;
    let reader;
    let expired = false;
    let timer;
    const unknown = (reason) => ({ status: 'unknown', reason });
    const work = async () => {
      const resolved = await resolveHost(host);
      if (expired) return unknown('SMTP connection timed out.');
      const records = (Array.isArray(resolved) ? resolved : [resolved]).map((record) => typeof record === 'string' ? { address: record } : record);
      if (!records.length || records.some((record) => !record || !isPublicAddress(record.address))) {
        return unknown('SMTP check blocked: mail exchanger resolves to a private or special-purpose address.');
      }
      const address = records[0].address;
      // Pin the connection to the validated address. No second DNS lookup may
      // replace it with an internal address between validation and connection.
      socket = socketFactory({ host: address, family: net.isIP(address), port });
      reader = makeReplyReader(socket);
      const command = async (line) => {
        socket.write(`${line}\r\n`);
        return reader.read();
      };
      const greeting = await reader.read();
      if (greeting.code !== 220) return unknown('SMTP server did not offer a ready greeting.');
      let hello = await command(`EHLO ${heloHost}`);
      if ([500, 502, 504].includes(hello.code)) hello = await command(`HELO ${heloHost}`);
      if (hello.code !== 250) return unknown('SMTP server declined the handshake.');
      const sender = await command('MAIL FROM:<>');
      if (sender.code !== 250) return unknown('SMTP server declined the empty return path; mailbox status is unknown.');
      const recipient = await command(`RCPT TO:<${email}>`);
      if ([250, 251].includes(recipient.code)) return {
        status: 'accepted',
        reason: 'SMTP server accepted the recipient; delivery is not guaranteed and catch-all behavior is untested.',
      };
      if (recipient.code === 550 && /^5\.1\.1(?:\s|$)/.test(recipient.lines.at(-1))) return {
        status: 'rejected', definitive: true,
        reason: 'SMTP server explicitly rejected the recipient with 550 5.1.1 (mailbox does not exist).',
      };
      return unknown(`SMTP server returned ${recipient.code}; this may be a temporary, policy, or privacy response.`);
    };
    try {
      return await Promise.race([
        work(),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            expired = true;
            socket?.destroy();
            resolve(unknown('SMTP check timed out or outbound SMTP is blocked by the hosting provider.'));
          }, timeoutMs);
        }),
      ]);
    } catch {
      return unknown('SMTP connection or DNS lookup failed; outbound SMTP may be blocked by the hosting provider.');
    } finally {
      clearTimeout(timer);
      if (socket && !socket.destroyed && socket.writable !== false) {
        // End before DATA: this check never transmits an email message.
        socket.write('QUIT\r\n');
        socket.end();
      }
      reader?.dispose();
      socket?.destroy();
    }
  };
}
