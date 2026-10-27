import { checkBatch, createDnsResolver, parseInput } from './checker.js';

export const MAX_ADDRESSES = 50;
export const MAX_BODY_BYTES = 20_000;
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 10;

export const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

const json = (data, status = 200, extraHeaders = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
});

function demoResults() {
  const row = (email, status, code, reason, checks, mx = []) => ({ email, normalized: email, domain: email.split('@')[1] || null, status, code, reason, checks, mx });
  const good = { syntax: 'pass', domain: 'pass', mail: 'pass', mailbox: 'unknown' };
  return [
    row('alex@accepted.test', 'delivered', 'demo_recipient_accepted', 'Simulated: server accepted RCPT TO. Delivery is not guaranteed; catch-all behavior is untested.', { ...good, mailbox: 'pass' }, [{ priority: 10, host: 'mx.accepted.test' }]),
    row('hello@routable.test', 'unknown', 'demo_mailbox_unverified', 'Simulated: mail routing exists, but the server does not confirm the mailbox.', good, [{ priority: 10, host: 'mx.routable.test' }]),
    row('missing-at-sign.test', 'bounce', 'demo_invalid_syntax', 'Simulated: the address is missing an @ and domain.', { syntax: 'fail', domain: 'unknown', mail: 'unknown', mailbox: 'unknown' }),
    row('team@no-mail.test', 'bounce', 'demo_null_mx', 'Simulated: the domain publishes Null MX and accepts no email.', { syntax: 'pass', domain: 'pass', mail: 'fail', mailbox: 'unknown' }, [{ priority: 0, host: '.' }]),
    row('sam@slow-dns.test', 'unknown', 'demo_dns_timeout', 'Simulated: DNS timed out. A temporary failure is not evidence of a bounce.', { syntax: 'pass', domain: 'unknown', mail: 'unknown', mailbox: 'unknown' }),
    row('pat@missing-mailbox.test', 'bounce', 'demo_mailbox_not_found', 'Simulated: server explicitly rejected the mailbox with 550 5.1.1.', { ...good, mailbox: 'fail' }, [{ priority: 10, host: 'mx.missing-mailbox.test' }]),
  ];
}

/** State is per process/function instance; it is deliberately not a distributed quota. */
export function createApiHandler({ probeMailbox, resolveDns, now = Date.now, requestTimeoutMs = 20_000 } = {}) {
  const buckets = new Map();
  return async function handleApi(request, { clientKey = 'local' } = {}) {
    const url = new URL(request.url);
    const mode = probeMailbox ? 'local-smtp' : 'dns';
    if (url.pathname === '/api/health') {
      if (request.method !== 'GET') return json({ error: 'Use GET for this endpoint.' }, 405, { Allow: 'GET' });
      return json({ name: 'MailSignal', version: '1.0.0', mode, smtpEnabled: Boolean(probeMailbox), maxAddresses: MAX_ADDRESSES, sendsMessages: false });
    }
    if (url.pathname === '/api/demo') {
      if (request.method !== 'GET') return json({ error: 'Use GET for this endpoint.' }, 405, { Allow: 'GET' });
      return json({ mode: 'demo', simulated: true, results: demoResults(), durationMs: 0, checkedAt: new Date(now()).toISOString() });
    }
    if (url.pathname !== '/api/check') return json({ error: 'Endpoint not found.' }, 404);
    if (request.method !== 'POST') return json({ error: 'Use POST with a JSON body: {"text":"address@example.com"}.' }, 405, { Allow: 'POST' });
    const origin = request.headers.get('origin');
    if ((origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
      return json({ error: 'Cross-origin requests are not allowed.' }, 403);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
      return json({ error: 'Send addresses as application/json.' }, 415);
    }
    if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) return json({ error: 'The request is too large.' }, 413);
    let data;
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json({ error: 'The request is too large.' }, 413);
      data = JSON.parse(raw);
    } catch { return json({ error: 'The request must contain valid JSON.' }, 400); }
    if (!data || typeof data.text !== 'string') return json({ error: 'Provide a text field containing the addresses.' }, 400);
    if (data.text.length > 16_000) return json({ error: 'Please keep your list under 16,000 characters.' }, 400);
    const addresses = parseInput(data.text);
    if (!addresses.length) return json({ error: 'Add at least one email address.' }, 400);
    if (addresses.length > MAX_ADDRESSES) return json({ error: `Check up to ${MAX_ADDRESSES} addresses at a time. Your list has ${addresses.length}.` }, 400);

    const started = now();
    // Purge stale buckets and cap memory use. Only an IP key and counters exist here.
    for (const [key, value] of buckets) if (value.reset <= started) buckets.delete(key);
    if (buckets.size >= 2000 && !buckets.has(clientKey)) return json({ error: 'The service is busy. Please retry in one minute.' }, 429, { 'Retry-After': '60' });
    const bucket = buckets.get(clientKey) || { count: 0, reset: started + WINDOW_MS };
    if (bucket.count >= MAX_REQUESTS) return json({ error: 'You have reached 10 checks in one minute. Please try again shortly.' }, 429, { 'Retry-After': String(Math.max(1, Math.ceil((bucket.reset - started) / 1000))) });
    bucket.count += 1;
    buckets.set(clientKey, bucket);

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const results = await checkBatch(addresses, {
        resolveDns: resolveDns || createDnsResolver({ timeoutMs: 2500, signal: controller.signal }),
        probeMailbox,
        concurrency: 8,
      });
      return json({ results, mode, simulated: false, durationMs: Math.max(0, now() - started), checkedAt: new Date(now()).toISOString() });
    } catch {
      // Never log request bodies, email lists, DNS query URLs, or SMTP replies.
      return json({ error: 'The check could not finish. Please retry.' }, 503);
    } finally { clearTimeout(deadline); }
  };
}
