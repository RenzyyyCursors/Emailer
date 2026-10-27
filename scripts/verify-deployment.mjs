import assert from "node:assert/strict";

const target = process.argv[2];
if (!target || process.argv.length !== 3) {
  console.error(
    "Usage: npm run verify:deployment -- https://YOUR-SERVICE.onrender.com",
  );
  process.exit(1);
}
const url = new URL(target);
if (
  url.username ||
  url.password ||
  (url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ))
) {
  throw new Error("Use a public HTTPS application URL, or HTTP on localhost.");
}
const base = url.origin;
async function request(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    signal: AbortSignal.timeout(path === "/" ? 120_000 : 30_000),
  });
  if (!response.ok)
    throw new Error(
      `${path} returned HTTP ${response.status}. Check the deployment logs, URL, root directory, and access protection.`,
    );
  return response;
}
try {
  const page = await (await request("/")).text();
  assert.match(
    page,
    /MailSignal/,
    "The URL did not return the MailSignal page.",
  );
  for (const path of ["/app.js", "/csv.js"]) {
    const asset = await request(path);
    assert.match(
      asset.headers.get("content-type") || "",
      /javascript/,
      `${path} is not served as JavaScript.`,
    );
    await asset.text();
  }
  console.log("PASS: application page and browser modules");
  const health = await (await request("/api/health")).json();
  assert.equal(
    health.mode,
    "dns",
    "This verification is for the hosted DNS-only version.",
  );
  assert.equal(health.smtpEnabled, false);
  assert.equal(health.sendsMessages, false);
  console.log("PASS: API reachable and DNS-only mode confirmed");
  const demo = await (await request("/api/demo")).json();
  assert.equal(demo.simulated, true);
  assert.deepEqual([...new Set(demo.results.map((row) => row.status))].sort(), [
    "bounce",
    "delivered",
    "unknown",
  ]);
  console.log("PASS: clearly simulated demo covers all three results");
  // DNS-only mode was confirmed above; no SMTP or messages are used here.
  const checked = await (
    await request("/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({
        text: "not-an-email\ncheck@does-not-exist.invalid\nteam@example.com\ncheck@gmail.com",
      }),
    })
  ).json();
  assert.equal(checked.simulated, false);
  assert.equal(checked.results.length, 4);
  const codes = checked.results.map((row) => row.code);
  const expected = ['invalid_syntax', 'domain_not_found', 'null_mx', 'mailbox_unverified'];
  if (codes.join('|') !== expected.join('|')) {
    throw new Error(`Unexpected evidence: ${codes.join(', ')}. DNS may be unavailable; inspect the result reasons and retry.`);
  }
  assert.deepEqual(
    checked.results.map((row) => row.status),
    ["bounce", "bounce", "bounce", "unknown"],
  );
  console.log("PASS: real syntax, NXDOMAIN, Null MX, and mail-routing checks");
  console.log(`Deployment verified at ${base}. No email messages were sent.`);
} catch (error) {
  console.error(`Verification failed: ${error.message}`);
  console.error(
    "A free Render service may need about a minute to wake. Open the URL, wait for the app, then retry.",
  );
  process.exitCode = 1;
}
