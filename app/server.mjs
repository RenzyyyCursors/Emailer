import http from "node:http";
import { createApiHandler } from "./src/api.js";
import { createHttpHandler } from "./src/http.js";
import { getRuntimeConfig } from "./src/runtime.js";
import { createSmtpProbe } from "./src/smtp.js";

const runtime = getRuntimeConfig();
const smtpProbe = runtime.smtpEnabled
  ? createSmtpProbe({
      allowedEmails: runtime.ownedEmails,
      heloHost: runtime.heloHost,
    })
  : null;
const handleApi = createApiHandler({
  probeMailbox: smtpProbe
    ? ({ normalized, mx }) => smtpProbe(normalized, mx)
    : undefined,
});
const server = http.createServer(
  createHttpHandler({ handleApi, publicProtocol: runtime.publicProtocol }),
);
server.requestTimeout = 25_000;
server.headersTimeout = 10_000;
server.listen(runtime.port, runtime.host, () => {
  console.log(`MailSignal is ready: http://${runtime.host}:${runtime.port}`);
  console.log(
    runtime.smtpEnabled
      ? "Mode: local SMTP, restricted to operator-owned addresses. No DATA is sent."
      : "Mode: DNS-only. Mailbox existence stays unknown. No messages are sent.",
  );
});
server.on("error", (error) => {
  console.error(
    error.code === "EADDRINUSE"
      ? `Port ${runtime.port} is busy. Set PORT to another number.`
      : "The server could not start.",
  );
  process.exitCode = 1;
});
