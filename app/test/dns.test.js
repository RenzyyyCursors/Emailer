import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeDnsResolver } from '../src/dns.js';

function fixture(method, result, { fail, fallback, signal, timeoutMs } = {}) {
  let cancelled = 0;
  let servers;
  const resolver = { setServers(value) { servers = value; }, cancel() { cancelled += 1; }, [method]: async () => { if (fail) throw Object.assign(new Error('DNS failed'), { code: fail }); return result; } };
  return { resolve: createNodeDnsResolver({ resolverFactory: () => resolver, fallback: fallback || (() => assert.fail('Unexpected HTTPS fallback')), signal, timeoutMs }), servers: () => servers, cancelled: () => cancelled };
}

test('native DNS uses explicit public resolvers and normalizes real Null MX representation', async () => {
  const dns = fixture('resolveMx', [{ priority: 0, exchange: '' }]);
  assert.deepEqual(await dns.resolve('example.com', 'MX'), { Status: 0, Answer: [{ type: 15, data: '0 .' }] });
  assert.deepEqual(dns.servers(), ['1.1.1.1', '8.8.8.8']);
});

test('native DNS converts MX, IPv4 and IPv6 replies to the shared classifier format', async () => {
  const mx = fixture('resolveMx', [{ priority: 10, exchange: 'mx.example.test' }]);
  assert.deepEqual((await mx.resolve('example.test', 'MX')).Answer, [{ type: 15, data: '10 mx.example.test' }]);
  for (const [type, method, ip, number] of [['A', 'resolve4', '8.8.8.8', 1], ['AAAA', 'resolve6', '2001:4860:4860::8888', 28]]) {
    assert.deepEqual((await fixture(method, [ip]).resolve('mx.example.test', type)).Answer, [{ type: number, data: ip }]);
  }
});

test('native NXDOMAIN and empty answers remain distinct and never need HTTPS fallback', async () => {
  assert.equal((await fixture('resolveMx', [], { fail: 'ENOTFOUND' }).resolve('missing.invalid', 'MX')).Status, 3);
  assert.equal((await fixture('resolveMx', [], { fail: 'ENODATA' }).resolve('example.test', 'MX')).Status, 0);
});

test('temporary native DNS failure uses HTTPS fallback, without inventing NXDOMAIN', async () => {
  let calls = 0;
  const fallback = async (name, type) => { calls += 1; assert.equal(name, 'example.test'); assert.equal(type, 'MX'); return { Status: 0, Answer: [] }; };
  assert.equal((await fixture('resolveMx', [], { fail: 'ETIMEOUT', fallback }).resolve('example.test', 'MX')).Status, 0);
  assert.equal(calls, 1);
  assert.equal((await fixture('resolveMx', [], { fail: 'ESERVFAIL', fallback: async () => { throw new Error('offline'); } }).resolve('example.test', 'MX')).Status, 2);
});

test('native timeout cancels stalled DNS and falls back within a bounded time', async () => {
  const dns = fixture('resolveMx', new Promise(() => {}), { timeoutMs: 5, fallback: async () => ({ Status: 2, Answer: [] }) });
  assert.equal((await dns.resolve('example.test', 'MX')).Status, 2);
  assert.equal(dns.cancelled(), 1);
});

test('batch cancellation cancels native DNS and does not start a fallback', async () => {
  const controller = new AbortController();
  const dns = fixture('resolveMx', new Promise(() => {}), { signal: controller.signal });
  const pending = dns.resolve('example.test', 'MX');
  controller.abort();
  assert.equal((await pending).error, 'aborted');
  assert.equal((await dns.resolve('other.test', 'MX')).error, 'aborted');
  assert.equal(dns.cancelled(), 1);
});
