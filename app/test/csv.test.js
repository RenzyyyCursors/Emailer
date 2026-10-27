import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCsv } from '../../public/csv.js';

const columns = ['Email', 'Normalized address', 'Result', 'Reason', 'Code', 'Syntax', 'Domain', 'Mail routing', 'Mailbox', 'Mail servers', 'Mode', 'Checked at'];
const checkedAt = '2026-10-27T12:30:00.000Z';

function result(overrides = {}) {
  return {
    email: 'Jane@example.test', normalized: 'Jane@example.test', status: 'unknown',
    reason: 'Routing exists; the mailbox is unverified.', code: 'mailbox_unverified',
    checks: { syntax: 'pass', domain: 'pass', mail: 'pass', mailbox: 'unknown' },
    mx: [{ priority: 10, host: 'mx.example.test' }], ...overrides,
  };
}

// An independent reader checks full round-tripping, including quoted newlines.
function readCsv(csv) {
  const text = csv.replace(/^\uFEFF/u, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (char === '\r' && text[index + 1] === '\n' && !quoted) {
      row.push(cell); rows.push(row); row = []; cell = ''; index += 1;
    } else cell += char;
  }
  assert.equal(quoted, false, 'every quoted field must close');
  assert.equal(cell, '', 'the final row must end with CRLF');
  assert.deepEqual(row, []);
  return rows;
}

test('CSV has UTF-8 BOM, CRLF, consistent columns, and a complete evidence row', () => {
  const csv = buildCsv([result()], { mode: 'dns', checkedAt });
  assert.ok(csv.startsWith('\uFEFF"Email"'));
  assert.ok(csv.endsWith('\r\n'));
  const rows = readCsv(csv);
  assert.deepEqual(rows[0], columns);
  assert.deepEqual(rows[1], [
    'Jane@example.test', 'Jane@example.test', 'Unknown', 'Routing exists; the mailbox is unverified.',
    'mailbox_unverified', 'pass', 'pass', 'pass', 'unknown', '10 mx.example.test', 'dns', checkedAt,
  ]);
  assert.ok(rows.every((row) => row.length === columns.length));
});

test('empty results still export a valid header and never create a phantom result', () => {
  assert.deepEqual(readCsv(buildCsv([])), [columns]);
});

test('commas, quotes, and embedded newlines round-trip without changing row boundaries', () => {
  const input = result({
    email: '"Doe, Jane"@example.test',
    reason: 'The server said "try later", then disconnected.\r\nKeep this as one cell.',
  });
  const csv = buildCsv([input, result({ email: 'next@example.test' })]);
  assert.match(csv, /""Doe, Jane""/);
  const rows = readCsv(csv);
  assert.equal(rows.length, 3);
  assert.equal(rows[1][0], input.email);
  assert.equal(rows[1][3], input.reason);
  assert.equal(rows[2][0], 'next@example.test');
});

test('spreadsheet formula prefixes are neutralized in email and every untrusted text column', () => {
  const payloads = [
    '=HYPERLINK("https://example.test","open")', '+SUM(1,2)', '-SUM(1,2)', '@SUM(1,2)',
    '   =1+1', '\t=1+1', '\r=1+1', '\n=1+1', '\u2003@SUM(1,2)',
  ];
  for (const payload of payloads) {
    const input = result({ email: payload, normalized: payload, reason: payload, code: payload });
    const [, row] = readCsv(buildCsv([input], { mode: payload, checkedAt: payload }));
    for (const index of [0, 1, 3, 4, 10, 11]) assert.equal(row[index], `'${payload}`);
  }
});

test('ordinary email addresses and existing leading apostrophes are preserved exactly', () => {
  const emails = ['Jane+intern@example.test', 'foo-bar@example.test', 'name=tag@example.test', "'literal@example.test"];
  const rows = readCsv(buildCsv(emails.map((email) => result({ email, normalized: email }))));
  assert.deepEqual(rows.slice(1).map((row) => row[0]), emails);
});

test('demo exports mark every fictional row with demo mode and the generation timestamp', () => {
  const inputs = [
    result({ email: 'accepted@example.test', status: 'delivered' }),
    result({ email: 'rejected@example.test', status: 'bounce' }),
    result({ email: 'uncertain@example.test', status: 'unknown' }),
  ];
  const rows = readCsv(buildCsv(inputs, { mode: 'demo', checkedAt }));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.slice(1).map((row) => row[2]), ['Likely delivered', 'Likely bounce', 'Unknown']);
  assert.ok(rows.slice(1).every((row) => row[10] === 'demo' && row[11] === checkedAt));
  assert.ok(rows.slice(1).every((row) => row[0].endsWith('.test')));
});

test('all result rows, order, duplicates, and independent evidence are preserved', () => {
  const inputs = Array.from({ length: 50 }, (_, index) => result({
    email: index % 2 ? 'duplicate@example.test' : `row${index}@example.test`,
    reason: `Evidence for input row ${index}`, status: ['delivered', 'bounce', 'unknown'][index % 3],
  }));
  const rows = readCsv(buildCsv(inputs));
  assert.equal(rows.length, 51);
  assert.deepEqual(rows.slice(1).map((row) => row[0]), inputs.map((row) => row.email));
  assert.deepEqual(rows.slice(1).map((row) => row[3]), inputs.map((row) => row.reason));
});

test('no-MX, multiple-MX, fallback status, and default metadata remain intelligible', () => {
  const inputs = [
    result({ mx: [], status: 'bounce', code: 'null_mx' }),
    result({ mx: [{ priority: 10, host: 'one.example.test' }, { priority: 20, host: 'two.example.test' }], status: 'future-status' }),
  ];
  const [, first, second] = readCsv(buildCsv(inputs));
  assert.equal(first[9], '');
  assert.equal(first[10], 'dns');
  assert.equal(first[11], '');
  assert.equal(second[9], '10 one.example.test; 20 two.example.test');
  assert.equal(second[2], 'Unknown');
});
