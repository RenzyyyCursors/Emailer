import { readFile } from "node:fs/promises";
import { securityHeaders, MAX_BODY_BYTES } from "./api.js";

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

/** The protocol comes from trusted runtime configuration, never a request header. */
export function createHttpHandler({ handleApi, publicProtocol = "http:" }) {
  if (!["http:", "https:"].includes(publicProtocol))
    throw new Error("Unsupported public protocol.");
  return async (req, res) => {
    for (const [key, value] of Object.entries(securityHeaders))
      res.setHeader(key, value);
    try {
      const url = new URL(
        req.url,
        `${publicProtocol}//${req.headers.host || "localhost"}`,
      );
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
        for (const [key, value] of Object.entries(req.headers)) {
          if (value != null)
            headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
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
        new URL(`../../public/${route[0]}`, import.meta.url),
      );
      res.writeHead(200, {
        "Content-Type": route[1],
        "Cache-Control": "no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : contents);
    } catch {
      if (!res.headersSent)
        res.writeHead(500, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
      res.end(
        JSON.stringify({
          error: "The service could not process this request.",
        }),
      );
    }
  };
}
