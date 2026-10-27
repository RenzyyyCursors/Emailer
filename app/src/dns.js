import { Resolver } from 'node:dns/promises';
import { createDnsResolver } from './checker.js';

/** Native DNS avoids dependency on a single HTTPS endpoint or local DNS server. */
export function createNodeDnsResolver({
  timeoutMs = 1800,
  signal,
  resolverFactory = () => new Resolver({ timeout: 1200, tries: 1 }),
  fallback = createDnsResolver({ timeoutMs: 1200, signal }),
} = {}) {
  return async (domain, type) => {
    if (signal?.aborted) return { Status: 2, Answer: [], error: 'aborted' };
    let resolver;
    let timer;
    let onAbort;
    let answer;
    try {
      resolver = resolverFactory();
      resolver.setServers(['1.1.1.1', '8.8.8.8']);
      const work = async () => {
        let Answer;
        if (type === 'MX') {
          const records = await resolver.resolveMx(domain);
          // Node represents the root exchange in Null MX as an empty string.
          Answer = records.map(({ priority, exchange }) => ({ type: 15, data: `${priority} ${exchange || '.'}` }));
        } else if (type === 'A' || type === 'AAAA') {
          const records = await resolver[type === 'A' ? 'resolve4' : 'resolve6'](domain);
          Answer = records.map((data) => ({ type: type === 'A' ? 1 : 28, data }));
        } else throw new Error('unsupported_query');
        return { Status: 0, Answer };
      };
      answer = await Promise.race([
        work(),
        new Promise((_, reject) => {
          onAbort = () => { resolver.cancel(); reject(new Error('aborted')); };
          signal?.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => { resolver.cancel(); reject(new Error('timeout')); }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (signal?.aborted) answer = { Status: 2, Answer: [], error: 'aborted' };
      else if (error.code === 'ENOTFOUND') answer = { Status: 3, Answer: [] };
      else if (error.code === 'ENODATA') answer = { Status: 0, Answer: [] };
      else answer = { Status: 2, Answer: [], error: 'dns_unavailable' };
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
    if (answer.Status !== 2 || signal?.aborted) return answer;
    try { return await fallback(domain, type); }
    catch { return { Status: 2, Answer: [], error: 'dns_unavailable' }; }
  };
}
