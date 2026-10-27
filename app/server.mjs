import http from "node:http";
import { readFile } from "node:fs/promises";
import {
  createApiHandler,
  securityHeaders,
  MAX_BODY_BYTES,
} from "./src/api.js";
import { createSmtpProbe } from "./src/smtp.js";
import { parseInput, validateEmail } from "./src/checker.js";

const owned = parseInput(process.env.SMTP_OWNED_EMAILS || "")
  .map((email) => validateEmail(email))
  .filter((item) => item.supported)
  .map((item) => item.normalized);
const smtpEnabled = !process.env.VERCEL && owned.length > 0;
const smtpProbe = smtpEnabled
  ? createSmtpProbe({
      allowedEmails: owned,
      heloHost: process.env.SMTP_HELO_HOST || "localhost",
    })
  : null;
const handleApi = createApiHandler({
  probeMailbox: smtpProbe
    ? ({ normalized, mx }) => smtpProbe(normalized, mx)
    : undefined,
});
const staticRoutes = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/fonts.css", ["fonts.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/csv.js", ["csv.js", "text/javascript; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
  ["/robots.txt", ["robots.txt", "text/plain; charset=utf-8"]],
]);
const server = http.createServer(async (req, res) => {
  for (const [key, value] of Object.entries(securityHeaders))
    res.setHeader(key, value);
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          res.writeHead(413, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify({ error: "The request is too large." }));
          return;
        }
        chunks.push(chunk);
      }
      const body =
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : Buffer.concat(chunks);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (value != null)
          headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const request = new Request(url, { method: req.method, headers, body });
      const response = await handleApi(request, {
        clientKey: req.socket.remoteAddress || "local",
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end("Method not allowed");
      return;
    }
    const route = staticRoutes.get(url.pathname);
    if (!route) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const contents = await readFile(
      new URL(`../public/${route[0]}`, import.meta.url),
    );
    res.writeHead(200, {
      "Content-Type": route[1],
      "Cache-Control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : contents);
  } catch {
    if (!res.headersSent)
      res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: "The service could not process this request." }),
    );
  }
});
const port = Number(process.env.PORT || 3000);
// Local SMTP must never be exposed as a public mailbox-probing API.
const host = smtpEnabled ? "127.0.0.1" : process.env.HOST || "127.0.0.1";
server.requestTimeout = 25_000;
server.headersTimeout = 10_000;
server.listen(port, host, () => {
  console.log(`MailSignal is ready: http://${host}:${port}`);
  console.log(
    smtpEnabled
      ? "Mode: local SMTP, restricted to operator-owned addresses. No DATA is sent."
      : "Mode: DNS-only. Mailbox existence stays unknown. No messages are sent.",
  );
});
server.on("error", (error) => {
  console.error(
    error.code === "EADDRINUSE"
      ? `Port ${port} is busy. Set PORT to another number.`
      : "The server could not start.",
  );
  process.exitCode = 1;
});
