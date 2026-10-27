import { parseInput, validateEmail } from "./checker.js";

/** Render terminates public HTTPS before forwarding requests to the Node server. */
export function getRuntimeConfig(env = process.env) {
  const hosted = Boolean(env.RENDER || env.VERCEL);
  const ownedEmails = parseInput(env.SMTP_OWNED_EMAILS || "")
    .map((email) => validateEmail(email))
    .filter((item) => item.supported)
    .map((item) => item.normalized);
  const smtpEnabled = !hosted && ownedEmails.length > 0;
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return {
    port,
    host: hosted
      ? "0.0.0.0"
      : smtpEnabled
        ? "127.0.0.1"
        : env.HOST || "127.0.0.1",
    publicProtocol: hosted ? "https:" : "http:",
    smtpEnabled,
    ownedEmails,
    heloHost: env.SMTP_HELO_HOST || "localhost",
  };
}
