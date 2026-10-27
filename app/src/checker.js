/**
 * Conservative email checks shared by the browser and the optional SMTP server.
 * DNS proves routing, never the existence of an individual mailbox.
 */

const ATOM = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/;
const QUOTED_LOCAL = /^"(?:[^"\\\r\n]|\\[^\r\n])*"$/;
const DNS_TYPES = { A: 1, AAAA: 28, MX: 15 };

function isDnsResponse(data) {
  return data && Number.isInteger(data.Status) && (data.Answer == null ||
    (Array.isArray(data.Answer) && data.Answer.every((record) => record && typeof record === 'object'
      && Number.isInteger(Number(record.type)) && typeof record.data === 'string')));
}

export function parseInput(text) {
  // Keep complete quoted local parts together so we can explain unsupported syntax.
  return String(text ?? '').match(/"(?:[^"\\\r\n]|\\[^\r\n])*"@[^\s,;]+|[^\s,;]+/gu) || [];
}

export function validateEmail(input) {
  const email = String(input ?? '').trim();
  const at = email.lastIndexOf('@');
  const local = at < 0 ? '' : email.slice(0, at);
  const originalDomain = at < 0 ? '' : email.slice(at + 1);
  let domain = originalDomain.toLowerCase();
  const result = (status, code, reason) => ({
    email,
    normalized: at < 0 ? email : `${local}@${domain}`,
    valid: status === 'unknown' ? null : status === 'pass',
    supported: status === 'pass',
    status,
    code,
    reason,
    domain: domain || null,
  });

  if (!local || !originalDomain) return result('fail', 'invalid_syntax', 'An address needs a local part, @, and a domain.');
  if (/[\u0000-\u001f\u007f]/u.test(email)) return result('fail', 'invalid_syntax', 'An address cannot contain control characters.');

  const quoted = QUOTED_LOCAL.test(local);
  const unicodeLocal = /[^\x00-\x7f]/u.test(local);
  if (!quoted && !ATOM.test(local)) {
    // SMTPUTF8 dot-atoms are plausible but cannot be checked by this ASCII SMTP client.
    const plausibleUtf8 = unicodeLocal && !/[\s()<>\[\]:;\\,"@]/u.test(local)
      && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..');
    if (!plausibleUtf8) return result('fail', 'invalid_syntax', 'The local part has invalid characters or dot placement.');
  }
  if (new TextEncoder().encode(local).length > 64) return result('fail', 'local_part_too_long', 'The local part exceeds the 64-byte email limit.');

  if (domain.startsWith('[') && domain.endsWith(']') && !/[\s<>@]/u.test(domain)) {
    return result('unknown', 'address_literal_unsupported', 'Address literals need a specialized SMTP check and are not supported here.');
  }
  if (/[\s/:?#@\\%\[\]]/u.test(domain) || domain.endsWith('.')) {
    return result('fail', 'invalid_domain', 'The domain is not a valid public DNS hostname.');
  }
  try {
    // URL hostname processing implements IDNA; it is available in Node and browsers.
    const hostname = new URL(`https://${domain}`).hostname.toLowerCase();
    // URL also expands numeric IPv4 shorthand; that is not IDNA normalization.
    if (/^[\x00-\x7f]+$/u.test(domain) && hostname !== domain) {
      return result('fail', 'invalid_domain', 'Use a DNS hostname, rather than a numeric host shorthand.');
    }
    domain = hostname;
  } catch {
    return result('fail', 'invalid_domain', 'The domain cannot be converted to a valid DNS hostname.');
  }
  if (!domain || domain.length > 253 || domain.split('.').some((label) =>
    label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) {
    return result('fail', 'invalid_domain', 'Domain labels must be valid DNS names of at most 63 characters.');
  }
  if (new TextEncoder().encode(`${local}@${domain}`).length > 254) {
    return result('fail', 'address_too_long', 'The address exceeds the 254-byte email limit.');
  }
  if (quoted) return result('unknown', 'quoted_local_unsupported', 'Quoted local parts need specialized parsing and are not supported here.');
  if (unicodeLocal) return result('unknown', 'smtputf8_unsupported', 'This international local part requires SMTPUTF8; mailbox verification is unavailable.');
  return result('pass', 'syntax_valid', 'The address has supported email syntax.');
}

/** A small DNS-over-HTTPS adapter: network failures are temporary, never NXDOMAIN. */
export function createDnsResolver({ fetchImpl = globalThis.fetch, timeoutMs = 4000, signal } = {}) {
  return async (domain, type) => {
    if (signal?.aborted) return { Status: 2, Answer: [], error: 'aborted' };
    const controller = new AbortController();
    let timer;
    let onAbort;
    try {
      const timeout = new Promise((_, reject) => {
        onAbort = () => {
          controller.abort();
          reject(new Error('aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('timeout'));
        }, Math.max(1, Number(timeoutMs) || 4000));
      });
      const request = (async () => {
        const response = await fetchImpl(`https://1.1.1.1/dns-query?name=${encodeURIComponent(domain)}&type=${encodeURIComponent(type)}`, {
          headers: { Accept: 'application/dns-json' },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('http_error');
        const data = await response.json();
        if (!isDnsResponse(data)) {
          throw new Error('invalid_response');
        }
        return { ...data, Answer: data.Answer || [] };
      })();
      return await Promise.race([request, timeout]);
    } catch (error) {
      return { Status: 2, Answer: [], error: signal?.aborted ? 'aborted' : error?.message === 'timeout' || controller.signal.aborted ? 'timeout' : 'dns_unavailable' };
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  };
}

function bounded(limit) {
  let active = 0;
  const queue = [];
  return (task) => new Promise((resolve, reject) => {
    const run = () => {
      active += 1;
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        active -= 1;
        queue.shift()?.();
      });
    };
    if (active < limit) run();
    else queue.push(run);
  });
}

function parseMx(answer) {
  const records = [];
  for (const record of answer || []) {
    if (Number(record.type) !== DNS_TYPES.MX) continue;
    const match = String(record.data ?? '').trim().match(/^(\d+)\s+(\S+)$/);
    if (!match) return null;
    const priority = Number(match[1]);
    const host = match[2] === '.' ? '.' : match[2].replace(/\.$/, '').toLowerCase();
    if (priority > 65535 || !host || (host !== '.' && host.split('.').some((label) =>
      label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)))) return null;
    if (!records.some((item) => item.priority === priority && item.host === host)) records.push({ priority, host });
  }
  return records.sort((a, b) => a.priority - b.priority || a.host.localeCompare(b.host));
}

/**
 * @param {string[]} addresses Every input row is retained, including duplicates.
 * @param {object} options Injectable DNS and SMTP adapters keep the core testable.
 * probeMailbox receives { email, normalized, domain, mx }. A rejected result must
 * include definitive:true; policy blocks and temporary rejections stay unknown.
 */
export async function checkBatch(addresses, { resolveDns = createDnsResolver(), probeMailbox, concurrency = 5 } = {}) {
  const rows = Array.isArray(addresses) ? addresses : parseInput(addresses);
  const limit = Math.min(20, Math.max(1, Math.floor(Number(concurrency) || 5)));
  const runDns = bounded(limit);
  const runCheck = bounded(limit);
  const dnsCache = new Map();
  const resultCache = new Map();

  const resolve = (domain, type) => {
    const key = `${domain.toLowerCase()}|${type}`;
    if (!dnsCache.has(key)) {
      dnsCache.set(key, runDns(async () => {
        try {
          const answer = await resolveDns(domain, type);
          if (!isDnsResponse(answer) || answer.TC === true) {
            return { Status: 2, Answer: [], error: 'invalid_response' };
          }
          return { ...answer, Answer: answer.Answer || [] };
        } catch {
          return { Status: 2, Answer: [], error: 'dns_unavailable' };
        }
      }));
    }
    return dnsCache.get(key);
  };

  const addressState = async (host) => {
    const answers = await Promise.all(['A', 'AAAA'].map((type) => resolve(host, type)));
    if (answers.some((answer, index) => answer.Status === 0 && answer.Answer.some((record) =>
      Number(record.type) === (index === 0 ? DNS_TYPES.A : DNS_TYPES.AAAA) && String(record.data || '').trim()))) return 'pass';
    if (answers.every((answer) => answer.Status === 0 || answer.Status === 3)) return 'fail';
    return 'unknown';
  };

  const check = async (validation) => {
    const { email, normalized, domain } = validation;
    const result = {
      email, normalized, domain,
      status: 'unknown', code: validation.code, reason: validation.reason, mx: [],
      checks: { syntax: validation.status, domain: 'unknown', mail: 'unknown', mailbox: 'unknown' },
    };
    const finish = (status, code, reason) => Object.assign(result, { status, code, reason });
    if (validation.status === 'fail') return finish('bounce', validation.code, validation.reason);
    if (validation.status === 'unknown') return result;

    const mxAnswer = await resolve(domain, 'MX');
    if (mxAnswer.Status === 3) {
      result.checks.domain = 'fail';
      result.checks.mail = 'fail';
      return finish('bounce', 'domain_not_found', 'The domain does not exist (DNS NXDOMAIN).');
    }
    if (mxAnswer.Status !== 0) return finish('unknown', 'dns_unavailable', 'DNS could not answer reliably. Retry later; this is not evidence of a bounce.');
    result.checks.domain = 'pass';
    const mx = parseMx(mxAnswer.Answer);
    if (mx === null) return finish('unknown', 'invalid_mx_response', 'The domain returned an unreadable mail-server record.');
    result.mx = mx;
    if (mx.some((record) => record.host === '.')) {
      if (mx.length === 1 && mx[0].priority === 0) {
        result.checks.mail = 'fail';
        return finish('bounce', 'null_mx', 'The domain explicitly declares that it does not accept email (Null MX).');
      }
      return finish('unknown', 'conflicting_mx', 'The domain mixes a Null MX with other or invalid mail-server records.');
    }

    if (mx.length === 0) {
      const state = await addressState(domain);
      result.checks.mail = state;
      if (state === 'fail') return finish('bounce', 'no_mail_route', 'The domain has no MX records and no A/AAAA address for the SMTP fallback.');
      if (state === 'unknown') return finish('unknown', 'mail_route_unavailable', 'No MX record was found, and the fallback address lookup could not finish reliably.');
      // RFC 5321 implicit MX: use the domain itself, with preference 0.
      result.mx = [{ priority: 0, host: domain }];
    } else {
      let sawUnknown = false;
      let routable = false;
      for (const record of mx) {
        const state = await addressState(record.host);
        if (state === 'pass') { routable = true; break; }
        if (state === 'unknown') sawUnknown = true;
      }
      result.checks.mail = routable ? 'pass' : sawUnknown ? 'unknown' : 'fail';
      if (!routable) {
        return result.checks.mail === 'fail'
          ? finish('bounce', 'mx_has_no_address', 'None of the advertised mail servers has an A or AAAA address.')
          : finish('unknown', 'mail_route_unavailable', 'Mail-server address lookups could not finish reliably. Retry later.');
      }
    }

    if (typeof probeMailbox !== 'function') {
      return finish('unknown', 'mailbox_unverified', 'Mail routing exists, but the mailbox is unverified. DNS alone cannot establish delivery.');
    }
    try {
      const probe = await probeMailbox({ email, normalized, domain, mx: result.mx.map((record) => ({ ...record })) });
      if (probe?.status === 'accepted') {
        result.checks.mailbox = 'pass';
        return finish('delivered', 'recipient_accepted', 'The mail server accepted the recipient check. Acceptance does not guarantee final delivery; catch-all behavior is untested.');
      }
      if (probe?.status === 'rejected' && probe.definitive === true) {
        result.checks.mailbox = 'fail';
        return finish('bounce', 'mailbox_not_found', probe.reason || 'The mail server explicitly reported that the mailbox does not exist.');
      }
      return finish('unknown', 'mailbox_unverified', probe?.reason || 'The mail server did not confirm whether the mailbox exists.');
    } catch {
      return finish('unknown', 'smtp_unavailable', 'The mailbox check could not connect or finish. This does not imply the address will bounce.');
    }
  };

  return Promise.all(rows.map((row) => {
    const validation = validateEmail(row);
    const key = validation.normalized;
    if (!resultCache.has(key)) resultCache.set(key, runCheck(() => check(validation)));
    return resultCache.get(key).then((result) => ({
      ...result, email: validation.email, mx: result.mx.map((record) => ({ ...record })), checks: { ...result.checks },
    }));
  }));
}
