/** Quoted cells plus formula neutralization protect spreadsheet exports. */
function cell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function buildCsv(results, { mode = 'dns', checkedAt = '' } = {}) {
  const labels = { delivered: 'Likely delivered', bounce: 'Likely bounce', unknown: 'Unknown' };
  const rows = [['Email', 'Normalized address', 'Result', 'Reason', 'Code', 'Syntax', 'Domain', 'Mail routing', 'Mailbox', 'Mail servers', 'Mode', 'Checked at']];
  for (const row of results) rows.push([
    row.email, row.normalized, labels[row.status] || 'Unknown', row.reason, row.code,
    row.checks.syntax, row.checks.domain, row.checks.mail, row.checks.mailbox,
    row.mx.map((mx) => `${mx.priority} ${mx.host}`).join('; '), mode, checkedAt,
  ]);
  return '\uFEFF' + rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
