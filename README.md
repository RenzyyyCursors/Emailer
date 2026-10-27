# MailSignal

A small email deliverability checker built for an internship assignment. Paste up to **50 addresses**, inspect the evidence for each result, filter or search the results, and export a CSV. The interface makes uncertainty visible instead of treating a valid domain as proof that a mailbox exists.

**Stack:** vanilla HTML/CSS/JavaScript, Node.js 22.9+, and Vercel Functions. No runtime dependencies, database, paid API, or API keys are required.

## Run locally

```bash
git clone https://github.com/RenzyyyCursors/Emailer.git
cd Emailer
npm start
```

Open [localhost:3000](http://localhost:3000). Install Node.js 22.9 or newer first; there are no packages to install. Use `npm run dev` for automatic server restarts. Optional configuration is documented in [`.env.example`](.env.example).

```bash
npm test       # deterministic unit and API tests; no real emails are sent
npm run check  # JavaScript syntax and required-file checks
```

## What a result means

| Result | Evidence | Practical meaning |
| --- | --- | --- |
| **Likely delivered** | An optional local SMTP check accepted an allowlisted recipient. | A positive signal, never a guarantee of inbox placement or eventual delivery. Catch-all behavior is untested. |
| **Likely to bounce** | Invalid supported syntax, NXDOMAIN, Null MX, no usable mail route, or an explicit local SMTP `550 5.1.1` rejection. | The check found a specific reason delivery is unlikely. |
| **Unknown** | A usable domain with an unverified mailbox; temporary DNS errors; SMTP privacy/policy responses; unsupported syntax. | There is not enough evidence to make a mailbox-level claim. |

The API uses status values `delivered`, `bounce`, and `unknown`. Each row includes a reason code, a readable explanation, syntax/domain/mail-route/mailbox check states, and any discovered MX records. Duplicate rows stay in the results; repeated lookups are shared within a batch.

The **simulated demo** uses reserved `.test` addresses and fixed fixtures to demonstrate all three outcomes without external DNS or SMTP calls. Its results are visibly labelled as simulated and are not mailbox verification.

## How it works

1. Parse addresses separated by newlines, commas, semicolons, or whitespace. Validate a supported email syntax subset; preserve local-part case and normalize the domain, including IDNA domains. Plausible quoted local parts, SMTPUTF8 local parts, and address literals return unknown rather than being silently rejected as invalid.
2. Ask Cloudflare DNS over HTTPS for MX records. Handle an explicit Null MX (`0 .`) as no email service. If no MX exists, check A/AAAA records for the SMTP implicit-MX fallback.
3. Resolve advertised mail-server addresses. A temporary lookup failure remains unknown; it is never turned into NXDOMAIN or a bounce.
4. Return the evidence. By default, a working DNS route still produces **unknown** because DNS cannot prove that an individual mailbox exists.

The local server and Vercel functions share the same checking engine. DNS concurrency is bounded, individual queries have timeouts, and batch lookups are cached in memory for that request.

## Vercel deployment and its limitation

**The Vercel deployment is DNS-only.** Vercel [blocks outbound SMTP on port 25](https://vercel.com/kb/guide/serverless-functions-and-smtp), the port used to contact a domain's receiving mail server. MailSignal therefore disables raw SMTP in its Vercel API, including when SMTP environment variables are present. A third-party SMTP submission service on port 465/587 would send through that service; it would not prove that an arbitrary recipient mailbox exists.

The deployed version can identify syntax and DNS routing problems. It **cannot confirm mailbox existence, catch-all behavior, inbox placement, spam filtering, or final delivery**. Real addresses with healthy routing normally return **unknown**. This is an intentional accuracy decision.

After pushing this folder to your GitHub repository:

1. Import the repository into Vercel.
2. Choose **Other** as the framework and keep the root directory at `./`.
3. Use Node.js 22.x or newer; `vercel.json` supplies `npm run build` and the `public` output directory.
4. Deploy. No environment variables are needed. Check `/api/health` and run a simulated demo from the app.

The root `api/` folder contains the serverless endpoints; `public/` contains the frontend. Do not set the Vercel root directory to `app/` or `public/`.

## Optional local SMTP checks

For a real positive mailbox signal, run locally on a network that permits outbound port 25 and configure only exact addresses **you own**:

```bash
cp .env.example .env
# Edit .env: set SMTP_OWNED_EMAILS and SMTP_HELO_HOST, then restart npm start.
```

SMTP is disabled by default. Only allowlisted full addresses can be probed. The check uses an empty return path, sends one `RCPT TO`, and closes before `DATA`; it never sends an email message. Private/special-purpose destination IPs are blocked. Network blocks, greylisting, ambiguous rejections, or timeouts return unknown. See [the SMTP design and safety details](docs/SMTP.md).

## Privacy and scope

- The app does not persist address lists, use analytics, or intentionally log request bodies. Reloading the page removes browser results; CSV files are downloaded only when requested. Clearing the input keeps the previous results visible until another check or reload.
- The API receives the submitted list. Only queried domain/mail-server names go to Cloudflare DNS; the local part is not included in DNS requests. Your hosting platform can retain its own access and infrastructure logs.
- Input and body sizes are bounded, output is rendered as text, CSV cells are escaped against formula injection, and basic security headers are configured.
- Rate limiting is best-effort and local to each process/function instance. A production service with untrusted traffic would need a shared rate limiter and stronger abuse controls.
- This is an evidence-based internship project, not a bulk mailing service. It does not send test messages, probe random catch-all recipients, or promise a deliverability percentage.

## Submission and interview

After deployment, generate a printable submission sheet with your actual links:

```bash
npm run submission -- --live https://YOUR-PROJECT.vercel.app --repo https://github.com/RenzyyyCursors/Emailer
```

Open the generated `submission.html` and use **Print → Save as PDF**. A starter PDF is also available at [`output/pdf/mailsignal-submission-template.pdf`](output/pdf/mailsignal-submission-template.pdf), with the deployment marked as pending. Replace it with the completed version before submitting. The live link must point to a real deployment; the repository does not pretend that one already exists. See [the interview guide](docs/INTERVIEW.md) for a short demo and engineering discussion points.

## Project layout

```text
public/          Browser interface and styles
api/             Vercel HTTP endpoints
app/server.mjs   Local HTTP server
app/src/         Shared checking engine, HTTP utilities, optional SMTP adapter
app/test/        Deterministic tests with injected DNS/SMTP fixtures
scripts/         Build checks and printable submission generator
docs/            SMTP design and interview preparation
```

The routing rules follow [RFC 5321 §5.1](https://www.rfc-editor.org/rfc/rfc5321#section-5.1) and [RFC 7505](https://www.rfc-editor.org/rfc/rfc7505). DNS requests use [Cloudflare's JSON DoH endpoint](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/).
