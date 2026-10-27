# Optional local SMTP checks

The default local application and hosted Render/Vercel deployments check address syntax and DNS mail routing. A working mail domain alone cannot confirm that an individual mailbox exists. The optional Node.js SMTP adapter adds an envelope-only check when you run the application locally and your network permits outbound TCP port 25.

The adapter is in `app/src/smtp.js`. SMTP is deliberately disabled when the `RENDER` or `VERCEL` hosting environment is detected; those deployments report mailbox existence as **unknown** after successful DNS checks. A local SMTP network block, timeout, privacy response, anti-spam policy, or temporary failure also returns **unknown**.

## Ownership requirement

Configure an explicit allowlist containing only complete email addresses you own or have permission to check. Domain wildcards are not supported. The adapter compares the whole address exactly, including letter case. Addresses outside the allowlist return **unknown** before any DNS lookup or socket connection. Never enable probing of arbitrary pasted addresses on a public service.

Example integration with a Node.js server:

```js
import { createSmtpProbe } from './src/smtp.js';

const probe = createSmtpProbe({
  allowedEmails: ['your-owned-mailbox@your-domain.example'],
  heloHost: 'your-machine.your-domain.example',
  timeoutMs: 5000,
});

// Supply MX records already found by the DNS stage.
const result = await probe('your-owned-mailbox@your-domain.example', [
  { priority: 10, host: 'mx.your-domain.example' },
]);
```

Do not run the placeholder example against someone else's domain. The example uses reserved documentation names and does not contact a real server.

## What the SMTP adapter does

1. Requires the recipient to be in the operator's exact-address ownership allowlist.
2. Resolves the preferred MX hostname and rejects private, loopback, link-local, multicast, and special-purpose IP ranges. Mixed public/private DNS results also fail closed.
3. Connects directly to a validated IP literal, so a second DNS lookup cannot redirect the socket to an internal address.
4. Reads the greeting, sends `EHLO` (or `HELO` for an unsupported command), then `MAIL FROM:<>` and one `RCPT TO:<owned-address>`.
5. Sends `QUIT` and closes the socket. It never sends `DATA`, a message body, or a random catch-all test recipient.

An SMTP `250` or `251` recipient response means **accepted**: a useful positive signal, with delivery still unproven. Some servers accept all recipients and later discard or bounce messages, so catch-all behavior stays **untested**. Only an explicit recipient response `550 5.1.1` becomes a definitive **rejected** result. Every other recipient response is **unknown**.

The whole operation, including DNS resolution, is bounded by a configurable timeout between 100 ms and 30 seconds. The default is five seconds. SMTP replies support multiline/chunked responses and have size limits. The adapter uses Node.js built-ins and no third-party dependencies.

## Tests

```bash
cd app
node --test test/smtp.test.js
```

The tests use an injected mock socket and resolver. They never connect to a real mailbox or transmit an email. They cover ownership enforcement, address pinning, internal IP blocking, accepted and rejected responses, unknown responses, malformed replies, multiline replies, fallback handshakes, and bounded DNS/socket timeouts.
