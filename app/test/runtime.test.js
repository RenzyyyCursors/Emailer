import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { getRuntimeConfig } from "../src/runtime.js";
import { createHttpHandler } from "../src/http.js";
import { createApiHandler } from "../src/api.js";

test("local runtime binds loopback and preserves owned SMTP opt-in", () => {
  const normal = getRuntimeConfig({});
  assert.equal(normal.host, "127.0.0.1");
  assert.equal(normal.port, 3000);
  assert.equal(normal.publicProtocol, "http:");
  assert.equal(normal.smtpEnabled, false);
  const smtp = getRuntimeConfig({
    SMTP_OWNED_EMAILS: "Mine@EXAMPLE.COM",
    HOST: "0.0.0.0",
  });
  assert.equal(smtp.smtpEnabled, true);
  assert.equal(smtp.host, "127.0.0.1");
  assert.deepEqual(smtp.ownedEmails, ["Mine@example.com"]);
});

test("Render runtime uses its PORT, binds publicly, and disables SMTP even with an allowlist", () => {
  const runtime = getRuntimeConfig({
    RENDER: "true",
    PORT: "10000",
    HOST: "127.0.0.1",
    SMTP_OWNED_EMAILS: "mine@example.com",
  });
  assert.equal(runtime.port, 10000);
  assert.equal(runtime.host, "0.0.0.0");
  assert.equal(runtime.publicProtocol, "https:");
  assert.equal(runtime.smtpEnabled, false);
  assert.equal(
    getRuntimeConfig({ VERCEL: "1", SMTP_OWNED_EMAILS: "mine@example.com" })
      .smtpEnabled,
    false,
  );
});

test("invalid listening ports fail with a clear configuration error", () => {
  for (const PORT of ["0", "-1", "65536", "abc", "3000.5"])
    assert.throws(() => getRuntimeConfig({ PORT }), /PORT must be an integer/);
});

async function withServer(t, publicProtocol) {
  const handleApi = createApiHandler({
    resolveDns: async () => {
      throw new Error("No DNS in HTTP regression tests");
    },
  });
  const server = http.createServer(
    createHttpHandler({ handleApi, publicProtocol }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

function forwardedPost(base, origin, forwardedProtocol = "https") {
  return new Promise((resolve, reject) => {
    // Node fetch owns its Host header. Use http.request to model Render's
    // original public Host arriving on an internal HTTP connection exactly.
    const req = http.request(
      base + "/api/check",
      {
        method: "POST",
        headers: {
          Host: "mailsignal.onrender.com",
          Origin: origin,
          "X-Forwarded-Proto": forwardedProtocol,
          "Content-Type": "application/json",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ text: "not-an-email" }));
  });
}

test("Render HTTPS requests forwarded internally over HTTP pass the same-origin guard", async (t) => {
  const base = await withServer(t, "https:");
  const response = await forwardedPost(base, "https://mailsignal.onrender.com");
  assert.equal(response.status, 200);
  assert.equal(response.body.results[0].code, "invalid_syntax");
});

test("Render origin guard still blocks another site and never trusts a spoofed protocol header", async (t) => {
  const base = await withServer(t, "https:");
  for (const Origin of [
    "https://other-site.test",
    "http://mailsignal.onrender.com",
  ]) {
    const response = await forwardedPost(base, Origin, "http");
    assert.equal(response.status, 403);
  }
});

test("local browser POST, static modules, health, and hidden-file boundaries work through HTTP", async (t) => {
  const base = await withServer(t, "http:");
  const response = await fetch(base + "/api/check", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "not-an-email" }),
  });
  assert.equal(response.status, 200);
  for (const path of [
    "/",
    "/app.js",
    "/csv.js",
    "/styles.css",
    "/api/health",
  ]) {
    const result = await fetch(base + path);
    assert.equal(result.status, 200, path);
    assert.equal(result.headers.get("x-content-type-options"), "nosniff");
    await result.text();
  }
  assert.equal((await fetch(base + "/.env")).status, 404);
  assert.equal((await fetch(base + "/app/src/smtp.js")).status, 404);
});
