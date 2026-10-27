import { createApiHandler, MAX_BODY_BYTES, securityHeaders } from "./api.js";

// Production deliberately cannot opt into SMTP, even if an env var is set.
const handleApi = createApiHandler();

export default async function handler(req, res) {
  for (const [key, value] of Object.entries(securityHeaders))
    res.setHeader(key, value);
  try {
    const body =
      req.method === "GET" || req.method === "HEAD"
        ? undefined
        : typeof req.body === "string"
          ? req.body
          : JSON.stringify(req.body ?? {});
    if (body && Buffer.byteLength(body) > MAX_BODY_BYTES) {
      res.statusCode = 413;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify({ error: "The request is too large." }));
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value != null)
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    const host = headers.get("host") || "localhost";
    const request = new Request(new URL(req.url, `https://${host}`), {
      method: req.method,
      headers,
      body,
    });
    // Vercel sets this header at its edge. The limiter is best effort per instance.
    const clientKey = (headers.get("x-forwarded-for") || "anonymous")
      .split(",")[0]
      .trim();
    const response = await handleApi(request, { clientKey });
    res.statusCode = response.status;
    for (const [key, value] of response.headers) res.setHeader(key, value);
    res.end(await response.text());
  } catch {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(
      JSON.stringify({ error: "The service could not process this request." }),
    );
  }
}
