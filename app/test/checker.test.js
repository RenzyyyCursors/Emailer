import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInput, validateEmail, createDnsResolver, checkBatch } from '../src/checker.js';

const ok = (...Answer) => ({ Status: 0, Answer });
const mx = (host, priority = 10) => ({ type: 15, data: `${priority} ${host}` });
const ipv4 = (data = '192.0.2.10') => ({ type: 1, data });
const ipv6 = () => ({ type: 28, data: '2001:db8::10' });
const absent = { Status: 3, Answer: [] };
const temporary = { Status: 2, Answer: [] };

function resolver(records) {
  const calls = [];
  const resolveDns = async (domain, type) => {
    calls.push(`${domain}:${type}`);
    return records[`${domain}:${type}`] ?? temporary;
  };
  return { resolveDns, calls };
}

function routed(domain = 'example.com', host = 'mx.example.com') {
  return {
    [`${domain}:MX`]: ok(mx(`${host}.`)),
    [`${host}:A`]: ok(ipv4()),
    [`${host}:AAAA`]: ok(),
  };
}

test('input accepts common separators, preserves duplicates, and keeps quoted local parts intact', () => {
  assert.deepEqual(parseInput(' A@example.com, b@example.com;\nc@example.com\tA@example.com '), [
    'A@example.com', 'b@example.com', 'c@example.com', 'A@example.com',
  ]);
  assert.deepEqual(parseInput('"Doe, Jane"@example.com; a@example.com'), ['"Doe, Jane"@example.com', 'a@example.com']);
  assert.deepEqual(parseInput(null), []);
});

test('syntax preserves local case and plus tags while normalizing international domains', () => {
  const value = validateEmail('  Jane+intern@BÜCHER.de  ');
  assert.equal(value.status, 'pass');
  assert.equal(value.normalized, 'Jane+intern@xn--bcher-kva.de');
  assert.equal(value.domain, 'xn--bcher-kva.de');
  assert.equal(validateEmail("a!#$%&'*+-/=?^_`{|}~@example.com").status, 'pass');
});

test('invalid dot placement, host syntax, controls, and numeric shortcuts fail syntax', () => {
  for (const email of [
    'missing-at', '@example.com', 'a@', '.a@example.com', 'a..b@example.com',
    'a.@example.com', 'a@-example.com', 'a@foo_.com', 'a@ex ample.com',
    'a@foo.com/path', 'a@foo.com:443', 'a@foo..com', 'a@foo.com.',
    'a\r\n@example.com', 'a@127.1', 'a@0127.0.0.1',
  ]) assert.equal(validateEmail(email).status, 'fail', email);
});

test('quoted, SMTPUTF8, and address-literal syntax stay unknown rather than bouncing', async () => {
  const values = ['"Jane Doe"@example.com', '"jane@work"@example.com', 'नमस्ते@example.com', 'a@[192.0.2.1]'];
  for (const value of values) assert.equal(validateEmail(value).status, 'unknown', value);
  const results = await checkBatch(values, { resolveDns: async () => { throw new Error('must not query'); } });
  assert.ok(results.every((result) => result.status === 'unknown' && result.checks.syntax === 'unknown'));
});

test('the 64-byte local-part and DNS label limits are enforced', () => {
  assert.equal(validateEmail(`${'a'.repeat(64)}@example.com`).status, 'pass');
  assert.equal(validateEmail(`${'a'.repeat(65)}@example.com`).code, 'local_part_too_long');
  assert.equal(validateEmail(`a@${'x'.repeat(64)}.com`).status, 'fail');
});

test('invalid syntax is a likely bounce without network requests', async () => {
  const { resolveDns, calls } = resolver({});
  const [result] = await checkBatch(['a..b@example.com'], { resolveDns });
  assert.equal(result.status, 'bounce');
  assert.equal(result.checks.syntax, 'fail');
  assert.deepEqual(calls, []);
});

test('NXDOMAIN is a likely bounce and does not invoke the mailbox probe', async () => {
  const { resolveDns, calls } = resolver({ 'missing.example:MX': absent });
  const [result] = await checkBatch(['a@missing.example'], {
    resolveDns, probeMailbox: async () => assert.fail('must not probe an absent domain'),
  });
  assert.equal(result.code, 'domain_not_found');
  assert.equal(result.status, 'bounce');
  assert.equal(result.checks.domain, 'fail');
  assert.deepEqual(calls, ['missing.example:MX']);
});

test('SERVFAIL, REFUSED, thrown errors, malformed DNS, and truncated DNS stay unknown', async () => {
  for (const answer of [temporary, { Status: 5 }, null, { Status: 0, Answer: 'bad' }, { Status: 0, Answer: [null] }, { Status: 0, Answer: [], TC: true }]) {
    const [result] = await checkBatch(['a@example.com'], { resolveDns: async () => answer });
    assert.equal(result.status, 'unknown');
    assert.equal(result.code, 'dns_unavailable');
  }
  const [result] = await checkBatch(['a@example.com'], { resolveDns: async () => { throw new Error('offline'); } });
  assert.equal(result.status, 'unknown');
});

test('Null MX is an explicit bounce and requires no address lookup', async () => {
  const { resolveDns, calls } = resolver({ 'example.com:MX': ok(mx('.', 0)) });
  const [result] = await checkBatch(['a@example.com'], { resolveDns });
  assert.equal(result.status, 'bounce');
  assert.equal(result.code, 'null_mx');
  assert.equal(result.checks.mail, 'fail');
  assert.equal(calls.length, 1);
});

test('mixed Null MX records and malformed MX data stay unknown', async () => {
  for (const Answer of [[mx('.', 0), mx('mx.example.com.')], [mx('.', 10)], [{ type: 15, data: 'not an MX record' }]]) {
    const [result] = await checkBatch(['a@example.com'], { resolveDns: async () => ok(...Answer) });
    assert.equal(result.status, 'unknown');
  }
});

test('a domain without MX can use the RFC SMTP A/AAAA fallback', async () => {
  const { resolveDns } = resolver({ 'example.com:MX': ok(), 'example.com:A': ok(ipv4()), 'example.com:AAAA': ok() });
  const [result] = await checkBatch(['a@example.com'], { resolveDns });
  assert.equal(result.status, 'unknown');
  assert.equal(result.checks.mail, 'pass');
  assert.deepEqual(result.mx, [{ priority: 0, host: 'example.com' }]);
});

test('no MX and definitively absent A/AAAA is a bounce', async () => {
  const { resolveDns } = resolver({ 'example.com:MX': ok(), 'example.com:A': ok(), 'example.com:AAAA': ok() });
  const [result] = await checkBatch(['a@example.com'], { resolveDns });
  assert.equal(result.status, 'bounce');
  assert.equal(result.code, 'no_mail_route');
});

test('a temporary fallback address failure cannot become a bounce', async () => {
  const { resolveDns } = resolver({ 'example.com:MX': ok(), 'example.com:A': ok(), 'example.com:AAAA': temporary });
  const [result] = await checkBatch(['a@example.com'], { resolveDns });
  assert.equal(result.status, 'unknown');
  assert.equal(result.checks.mail, 'unknown');
});

test('IPv6-only MX routing is supported, without claiming a mailbox exists', async () => {
  const { resolveDns } = resolver({ ...routed(), 'mx.example.com:A': ok(), 'mx.example.com:AAAA': ok(ipv6()) });
  const [result] = await checkBatch(['a@example.com'], { resolveDns });
  assert.equal(result.status, 'unknown');
  assert.equal(result.code, 'mailbox_unverified');
  assert.deepEqual(result.checks, { syntax: 'pass', domain: 'pass', mail: 'pass', mailbox: 'unknown' });
});

test('MX priority is respected and a working secondary MX prevents a false bounce', async () => {
  const { resolveDns, calls } = resolver({
    'example.com:MX': ok(mx('backup.example.com.', 20), mx('primary.example.com.', 10), mx('third.example.com.', 30)),
    'primary.example.com:A': ok(), 'primary.example.com:AAAA': ok(),
    'backup.example.com:A': ok(ipv4()), 'backup.example.com:AAAA': ok(),
  });
  const [result] = await checkBatch(['a@example.com'], { resolveDns });
  assert.equal(result.checks.mail, 'pass');
  assert.equal(result.mx[0].host, 'primary.example.com');
  assert.equal(result.status, 'unknown');
  assert.ok(!calls.some((call) => call.startsWith('third.')));
});

test('all MX hosts without addresses produce a bounce only when absence is definitive', async () => {
  const records = {
    'example.com:MX': ok(mx('one.example.com.'), mx('two.example.com.', 20)),
    'one.example.com:A': ok(), 'one.example.com:AAAA': absent,
    'two.example.com:A': ok(), 'two.example.com:AAAA': ok(),
  };
  let [result] = await checkBatch(['a@example.com'], resolver(records));
  assert.equal(result.status, 'bounce');
  assert.equal(result.code, 'mx_has_no_address');
  [result] = await checkBatch(['a@example.com'], resolver({ ...records, 'two.example.com:AAAA': temporary }));
  assert.equal(result.status, 'unknown');
});

test('only a positive SMTP recipient probe yields likely delivered, with a delivery caveat', async () => {
  let probeInput;
  const [result] = await checkBatch(['Jane@example.com'], {
    ...resolver(routed()),
    probeMailbox: async (input) => { probeInput = input; return { status: 'accepted' }; },
  });
  assert.equal(result.status, 'delivered');
  assert.equal(result.checks.mailbox, 'pass');
  assert.match(result.reason, /does not guarantee final delivery/i);
  assert.equal(probeInput.normalized, 'Jane@example.com');
  assert.deepEqual(probeInput.mx, [{ priority: 10, host: 'mx.example.com' }]);
});

test('SMTP rejection needs an explicit definite nonexistence flag; policy/temporary failures stay unknown', async () => {
  for (const definitive of [false, undefined, true]) {
    const [result] = await checkBatch(['a@example.com'], {
      ...resolver(routed()), probeMailbox: async () => ({ status: 'rejected', definitive, reason: '550 5.1.1 mailbox not found' }),
    });
    assert.equal(result.status, definitive ? 'bounce' : 'unknown');
  }
  const [result] = await checkBatch(['a@example.com'], {
    ...resolver(routed()), probeMailbox: async () => { throw new Error('blocked port'); },
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.code, 'smtp_unavailable');
});

test('rows and local case are retained while DNS and normalized duplicates are cached per batch', async () => {
  const { resolveDns, calls } = resolver(routed());
  let probes = 0;
  const results = await checkBatch(['Jane@EXAMPLE.COM', 'Jane@example.com', 'jane@example.com'], {
    resolveDns, probeMailbox: async () => { probes += 1; return { status: 'unknown' }; },
  });
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((result) => result.email), ['Jane@EXAMPLE.COM', 'Jane@example.com', 'jane@example.com']);
  assert.equal(probes, 2);
  assert.equal(calls.length, 3);
  results[0].checks.syntax = 'fail';
  assert.equal(results[1].checks.syntax, 'pass');
  await checkBatch(['a@example.com'], { resolveDns });
  assert.equal(calls.length, 6, 'cache is discarded after each batch');
});

test('DNS network concurrency is bounded independently of the number of rows', async () => {
  let active = 0;
  let maximum = 0;
  const resolveDns = async (domain, type) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    if (type === 'MX') return ok(mx(`mx.${domain}.`));
    return type === 'A' ? ok(ipv4()) : ok();
  };
  const results = await checkBatch(Array.from({ length: 12 }, (_, index) => `a@domain${index}.example`), { resolveDns, concurrency: 3 });
  assert.equal(results.length, 12);
  assert.ok(maximum > 1 && maximum <= 3, `maximum was ${maximum}`);
});

test('DNS-over-HTTPS requests JSON and passes the requested type and hostname', async () => {
  let request;
  const resolveDns = createDnsResolver({ fetchImpl: async (url, options) => {
    request = { url: new URL(url), options };
    return { ok: true, json: async () => ({ Status: 0 }) };
  } });
  assert.deepEqual(await resolveDns('xn--bcher-kva.de', 'MX'), ok());
  assert.equal(request.url.hostname, 'cloudflare-dns.com');
  assert.equal(request.url.searchParams.get('name'), 'xn--bcher-kva.de');
  assert.equal(request.url.searchParams.get('type'), 'MX');
  assert.equal(request.options.headers.Accept, 'application/dns-json');
});

test('DNS-over-HTTPS timeouts, HTTP failures, and malformed responses are temporary failures', async () => {
  for (const fetchImpl of [
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => ({ unexpected: true }) }),
    async () => { throw new Error('offline'); },
    async () => new Promise(() => {}),
  ]) {
    const resolveDns = createDnsResolver({ fetchImpl, timeoutMs: 5 });
    const result = await resolveDns('example.com', 'MX');
    assert.equal(result.Status, 2);
    assert.deepEqual(result.Answer, []);
  }
});

test('an external deadline cancels active and later DNS requests without a false NXDOMAIN', async () => {
  const controller = new AbortController();
  let requests = 0;
  const resolveDns = createDnsResolver({
    fetchImpl: async () => { requests += 1; return new Promise(() => {}); },
    timeoutMs: 10000, signal: controller.signal,
  });
  const pending = resolveDns('example.com', 'MX');
  controller.abort();
  assert.equal((await pending).error, 'aborted');
  assert.equal((await resolveDns('other.example', 'MX')).error, 'aborted');
  assert.equal(requests, 1);
});
