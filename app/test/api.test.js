import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiHandler, MAX_ADDRESSES, MAX_BODY_BYTES, securityHeaders } from '../src/api.js';
import vercelHandler from '../src/vercel.js';

const ORIGIN = 'https://mailsignal.test';
const FIXED_TIME = Date.parse('2026-10-27T12:00:00.000Z');

function request(path = '/api/check', { method = 'POST', body = { text: 'invalid-address' }, headers = {} } = {}) {
  if (method === 'GET' || method === 'HEAD') body = undefined;
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

function offlineApi(options = {}) {
  return createApiHandler({
    now: () => FIXED_TIME,
    resolveDns: async () => { throw new Error('Unexpected DNS lookup in an HTTP validation test.'); },
    ...options,
  });
}

function healthyDns(domain, type) {
  return Promise.resolve({
    Status: 0,
    Answer: type === 'MX' ? [{ name: domain, type: 15, data: '10 mx.mail.test.' }]
      : type === 'A' ? [{ name: domain, type: 1, data: '192.0.2.25' }] : [],
  });
}

function mockVercelRequest(path, { method = 'GET', body, headers = {} } = {}) {
  return { url: path, method, body, headers: { host: 'mailsignal.test', 'x-forwarded-for': '192.0.2.40', ...headers } };
}

function mockVercelResponse() {
  const headers = new Map();
  return {
    statusCode: 200,
    body: '',
    headers,
    ended: false,
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    end(body) { this.body = body; this.ended = true; },
    json() { return JSON.parse(this.body); },
  };
}

test('health describes DNS-only defaults and every API response has privacy/security headers', async () => {
  const handler = offlineApi();
  const response = await handler(request('/api/health', { method: 'GET', body: undefined }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    name: 'MailSignal', version: '1.0.0', mode: 'dns', smtpEnabled: false,
    maxAddresses: MAX_ADDRESSES, sendsMessages: false,
  });
  for (const [name, value] of Object.entries(securityHeaders)) assert.equal(response.headers.get(name), value);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-type'), /^application\/json/);

  const error = await handler(request('/api/missing', { method: 'GET', body: undefined }));
  assert.equal(error.status, 404);
  assert.equal(error.headers.get('cache-control'), 'no-store');
  assert.equal(error.headers.get('x-content-type-options'), 'nosniff');
});

test('health reports local SMTP capability without executing a probe', async () => {
  let called = false;
  const handler = offlineApi({ probeMailbox: () => { called = true; } });
  const response = await handler(request('/api/health', { method: 'GET', body: undefined }));
  const data = await response.json();
  assert.equal(data.mode, 'local-smtp');
  assert.equal(data.smtpEnabled, true);
  assert.equal(data.sendsMessages, false);
  assert.equal(called, false);
});

test('unknown routes and unsupported methods fail before processing addresses', async () => {
  const handler = offlineApi();
  for (const [path, method, expectedAllow] of [
    ['/api/check', 'GET', 'POST'], ['/api/check', 'OPTIONS', 'POST'],
    ['/api/demo', 'POST', 'GET'], ['/api/health', 'POST', 'GET'],
  ]) {
    const response = await handler(request(path, { method, body: method === 'GET' ? undefined : {} }));
    assert.equal(response.status, 405, `${method} ${path}`);
    assert.equal(response.headers.get('allow'), expectedAllow);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.equal((await handler(request('/api/not-found'))).status, 404);
});

test('blocks foreign Origin and cross-site fetches, and permits same-origin requests', async () => {
  const handler = offlineApi();
  for (const headers of [
    { Origin: 'https://another-site.test' },
    { Origin: 'null' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' },
  ]) assert.equal((await handler(request('/api/check', { headers }))).status, 403);
  assert.equal((await handler(request('/api/check', { headers: { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin' } }))).status, 200);
  assert.equal((await handler(request())).status, 200);
});

test('requires JSON media type and validates malformed, missing and non-string JSON input', async () => {
  const handler = offlineApi();
  for (const contentType of ['text/plain', 'text/html', 'application/jsonp', '']) {
    const response = await handler(request('/api/check', { headers: { 'Content-Type': contentType } }));
    assert.equal(response.status, 415, contentType);
  }
  for (const body of ['', '{', 'null', '[]', '42', '{}', '{"text":42}', '{"text":null}']) {
    const response = await handler(request('/api/check', { body }));
    assert.equal(response.status, 400, body);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  const accepted = await handler(request('/api/check', { headers: { 'Content-Type': 'Application/JSON; charset=utf-8' } }));
  assert.equal(accepted.status, 200);
});

test('enforces declared and actual UTF-8 body limits before checking addresses', async () => {
  const handler = offlineApi();
  const declared = await handler(request('/api/check', { headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) } }));
  assert.equal(declared.status, 413);
  const actual = await handler(request('/api/check', { body: { text: 'x'.repeat(MAX_BODY_BYTES) } }));
  assert.equal(actual.status, 413);
  const unicode = await handler(request('/api/check', { body: { text: 'ಅ'.repeat(7000) } }));
  assert.equal(unicode.status, 413, 'Limit must count UTF-8 bytes rather than JS characters.');
  const textTooLong = await handler(request('/api/check', { body: { text: 'x'.repeat(16001) } }));
  assert.equal(textTooLong.status, 400);
  assert.match((await textTooLong.json()).error, /16,000/);
});

test('rejects empty lists and more than 50 rows while preserving 50 valid input rows', async () => {
  const handler = offlineApi();
  for (const text of ['', ' \n\t,;; ']) assert.equal((await handler(request('/api/check', { body: { text } }))).status, 400);
  const overLimit = Array.from({ length: MAX_ADDRESSES + 1 }, (_, index) => `invalid-${index}`).join('\n');
  const tooMany = await handler(request('/api/check', { body: { text: overLimit } }));
  assert.equal(tooMany.status, 400);
  assert.match((await tooMany.json()).error, /51/);
  const atLimit = Array.from({ length: MAX_ADDRESSES }, (_, index) => `invalid-${index}`).join('\n');
  const accepted = await handler(request('/api/check', { body: { text: atLimit } }));
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).results.length, MAX_ADDRESSES);
});

test('limits each client to 10 checks per minute and resets at the window boundary', async () => {
  let now = FIXED_TIME;
  const handler = offlineApi({ now: () => now });
  for (let index = 0; index < 10; index += 1) assert.equal((await handler(request(), { clientKey: 'client-a' })).status, 200);
  const limited = await handler(request(), { clientKey: 'client-a' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal((await handler(request(), { clientKey: 'client-b' })).status, 200);
  now += 59_500;
  const almostReset = await handler(request(), { clientKey: 'client-a' });
  assert.equal(almostReset.status, 429);
  assert.equal(almostReset.headers.get('retry-after'), '1');
  now += 500;
  assert.equal((await handler(request(), { clientKey: 'client-a' })).status, 200);
});

test('invalid requests do not spend the valid-check quota', async () => {
  const handler = offlineApi();
  for (let index = 0; index < 12; index += 1) {
    assert.equal((await handler(request('/api/check', { body: {} }), { clientKey: 'client' })).status, 400);
  }
  assert.equal((await handler(request(), { clientKey: 'client' })).status, 200);
});

test('demo is clearly simulated and returns all three outcomes without DNS or SMTP', async () => {
  let probeCalled = false;
  const handler = offlineApi({ probeMailbox: () => { probeCalled = true; } });
  const response = await handler(request('/api/demo', { method: 'GET', body: undefined }));
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.mode, 'demo');
  assert.equal(data.simulated, true);
  assert.equal(data.checkedAt, '2026-10-27T12:00:00.000Z');
  assert.deepEqual(new Set(data.results.map((row) => row.status)), new Set(['delivered', 'bounce', 'unknown']));
  for (const row of data.results) {
    assert.match(row.code, /^demo_/);
    assert.match(row.reason, /^Simulated:/);
    assert.ok(row.domain === null || row.domain.endsWith('.test'));
  }
  assert.equal(probeCalled, false);
});

test('live healthy DNS results stay unknown without a mailbox probe', async () => {
  const calls = [];
  const handler = offlineApi({ resolveDns: async (domain, type) => {
    calls.push({ domain, type });
    return healthyDns(domain, type);
  } });
  const response = await handler(request('/api/check', { body: { text: 'one@routing.test\ntwo@routing.test\none@routing.test' } }));
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.mode, 'dns');
  assert.equal(data.simulated, false);
  assert.equal(data.checkedAt, '2026-10-27T12:00:00.000Z');
  assert.equal(data.durationMs, 0);
  assert.equal(data.results.length, 3);
  assert.deepEqual(data.results.map((row) => row.email), ['one@routing.test', 'two@routing.test', 'one@routing.test']);
  for (const row of data.results) {
    assert.equal(row.status, 'unknown');
    assert.equal(row.code, 'mailbox_unverified');
    assert.deepEqual(row.checks, { syntax: 'pass', domain: 'pass', mail: 'pass', mailbox: 'unknown' });
  }
  assert.equal(calls.filter((call) => call.type === 'MX').length, 1, 'One domain should share its DNS lookup within a batch.');
  assert.ok(data.results.every((row) => row.status !== 'delivered'));
});

test('malformed DNS payloads and resolver errors remain unknown through the HTTP API', async () => {
  for (const resolveDns of [
    async () => undefined,
    async () => ({ Status: '0', Answer: [] }),
    async () => ({ Status: 0, Answer: 'not an array' }),
    async () => ({ Status: 0, Answer: [{ type: 15, data: 'malformed MX' }] }),
    async () => { throw new Error('Private failure detail that must not reach the response'); },
  ]) {
    const handler = offlineApi({ resolveDns });
    const response = await handler(request('/api/check', { body: { text: 'person@routing.test' } }));
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.results[0].status, 'unknown');
    assert.equal(JSON.stringify(data).includes('Private failure detail'), false);
  }
});

test('Vercel route entrypoints all export the shared handler', async () => {
  for (const name of ['check', 'demo', 'health']) {
    const route = await import(`../../api/${name}.js`);
    assert.equal(route.default, vercelHandler, name);
  }
});

test('Vercel remains DNS-only when local SMTP environment variables are present', async () => {
  const previousOwned = process.env.SMTP_OWNED_EMAILS;
  const previousFetch = globalThis.fetch;
  let dnsCalls = 0;
  process.env.SMTP_OWNED_EMAILS = 'owned@routing.test';
  globalThis.fetch = async (url) => {
    const query = new URL(url);
    assert.equal(query.origin, 'https://cloudflare-dns.com');
    dnsCalls += 1;
    return Response.json(await healthyDns(query.searchParams.get('name'), query.searchParams.get('type')));
  };
  try {
    const health = mockVercelResponse();
    await vercelHandler(mockVercelRequest('/api/health'), health);
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().mode, 'dns');
    assert.equal(health.json().smtpEnabled, false);
    assert.equal(health.json().sendsMessages, false);

    const check = mockVercelResponse();
    await vercelHandler(mockVercelRequest('/api/check', {
      method: 'POST', body: { text: 'owned@routing.test' }, headers: { 'content-type': 'application/json' },
    }), check);
    assert.equal(check.statusCode, 200);
    assert.equal(check.ended, true);
    assert.equal(check.json().mode, 'dns');
    assert.equal(check.json().simulated, false);
    assert.equal(check.json().results[0].status, 'unknown');
    assert.equal(check.headers.get('cache-control'), 'no-store');
    assert.ok(dnsCalls > 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousOwned === undefined) delete process.env.SMTP_OWNED_EMAILS;
    else process.env.SMTP_OWNED_EMAILS = previousOwned;
  }
});

test('Vercel adapter preserves method/origin guards and handles oversized or malformed requests', async () => {
  const method = mockVercelResponse();
  await vercelHandler(mockVercelRequest('/api/check'), method);
  assert.equal(method.statusCode, 405);
  assert.equal(method.headers.get('allow'), 'POST');
  const foreign = mockVercelResponse();
  await vercelHandler(mockVercelRequest('/api/check', {
    method: 'POST', body: { text: 'invalid-address' },
    headers: { 'content-type': 'application/json', origin: 'https://foreign.test' },
  }), foreign);
  assert.equal(foreign.statusCode, 403);
  const huge = mockVercelResponse();
  await vercelHandler(mockVercelRequest('/api/check', {
    method: 'POST', body: { text: 'x'.repeat(MAX_BODY_BYTES) }, headers: { 'content-type': 'application/json' },
  }), huge);
  assert.equal(huge.statusCode, 413);
  assert.equal(huge.headers.get('cache-control'), 'no-store');
  const malformed = mockVercelResponse();
  await vercelHandler(mockVercelRequest('/api/check', {
    method: 'POST', body: '{ invalid json', headers: { 'content-type': 'application/json' },
  }), malformed);
  assert.equal(malformed.statusCode, 400);
  const brokenRequest = mockVercelResponse();
  await vercelHandler({ url: '/api/health', method: 'GET', headers: { host: 'bad host with spaces' } }, brokenRequest);
  assert.equal(brokenRequest.statusCode, 500);
  assert.equal(brokenRequest.json().error, 'The service could not process this request.');
});
