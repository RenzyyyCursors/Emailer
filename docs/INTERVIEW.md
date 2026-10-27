# Presenting MailSignal

Understand and run the project yourself before presenting it. Describe the parts you can explain, acknowledge assistance if asked, and use this guide to prepare a discussion rather than memorizing claims.

## A two-minute demo

1. **Introduce the problem (15 seconds).** “MailSignal checks a pasted address list and explains which addresses are likely to bounce, which have a positive SMTP signal, and which cannot be verified.”
2. **Run the simulated demo (30 seconds).** Show the three outcomes and the simulation label. Expand a row's evidence, filter by status, search for a domain, and export a CSV. Explain that fixtures make the presentation repeatable without contacting anyone's mailbox.
3. **Run a real DNS check (30 seconds).** Use an address you own and an obviously malformed input. Explain why a working mail route returns unknown on Render Free or Vercel. A DNS record describes a domain's routing, not the existence of a particular user.
4. **Explain one implementation choice (30 seconds).** Show how a temporary DNS failure becomes unknown, while an authoritative NXDOMAIN or Null MX becomes bounce. Point to a deterministic test that demonstrates the distinction.
5. **Close with the deployment constraint (15 seconds).** Render Free and Vercel block outbound port 25, so the hosted version stays DNS-only. Optional local SMTP checks are restricted to exact owned addresses and stop before any message body is sent.

## Engineering decisions worth discussing

| Decision | Reason | Tradeoff |
| --- | --- | --- |
| Three outcomes with evidence | Avoid false confidence when servers hide mailbox existence. | Many valid addresses return unknown. |
| Shared checking engine | The local server and Vercel API use the same classification rules. | Runtime-specific HTTP and SMTP adapters still need separate handling. |
| No runtime dependencies | A small project is easy to inspect, run, and deploy. | Parsing and protocol code must be scoped carefully and tested. |
| Native DNS with HTTPS fallback | Avoids a single DNS transport failure. | Relies on a third-party resolver; lookup failures must be handled explicitly. |
| Per-batch caching and bounded concurrency | Duplicate domains avoid repeated work and requests do not create unlimited DNS queries. | This is not a shared cache across deployments. |
| Exact owned-address SMTP allowlist | Prevent arbitrary mailbox probing through the local server. | The operator must configure and maintain the allowlist. |
| Deterministic network fixtures | Tests are fast, reproducible, and never email anyone. | Fixtures cannot demonstrate a particular provider's live policy. |

## Questions to practice

**Why not mark every valid MX domain as delivered?**

An MX record points to receiving infrastructure. The named mailbox may not exist, may be disabled, or may reject mail after the server accepts it. The default result is unknown until there is mailbox-level evidence.

**Why is an address without an MX record not always a bounce?**

SMTP supports an implicit-MX fallback to the domain's A/AAAA address when no MX is present. A domain with no MX but a usable address is a possible route, so mailbox existence remains unknown.

**What is Null MX?**

The single MX record `0 .` explicitly declares that the domain accepts no mail. It is different from an empty MX response and stops the address fallback.

**What happens when DNS times out?**

The checker returns unknown with a retryable explanation. A transport error is not evidence that the domain does not exist. NXDOMAIN is handled separately.

**Does an SMTP acceptance prove delivery?**

No. A server might accept all recipients, apply a policy later, or bounce a message after acceptance. The app describes acceptance as a positive signal and does not claim catch-all detection or inbox placement. No actual message is sent.

**Why not test catch-all behavior using a random address?**

That would probe an address the operator does not own. The project avoids that behavior and labels catch-all detection as untested.

**How is the SMTP adapter protected from SSRF?**

It validates the destination hostname, resolves its addresses, rejects private and special-purpose ranges, and pins the connection to a validated IP literal. An exact recipient allowlist is checked before opening a connection. It also bounds time, reply size, and line size.

**Does the app support every legal email address?**

No. It validates a documented practical subset. Plausible quoted local parts, SMTPUTF8 local parts, and address literals are explicitly unknown. The app supports international domain normalization without claiming full international mailbox verification.

**What does “no persistence” mean?**

The application does not write address lists to a database or file and does not intentionally log them. The server receives the list to process it; domain names go to Cloudflare or Google Public DNS. Hosting infrastructure may keep its own logs, so “nothing ever leaves the browser” would be inaccurate.

**What would you change for production?**

Start with a shared rate limiter, abuse monitoring, stricter request quotas, operational metrics that do not include full addresses, and explicit data-retention controls. Larger workloads would use a queue with cancellation, backoff, and bounded worker concurrency. Add authentication if it becomes a private business tool. Improve the parser through standards-focused tests before expanding accepted syntax.

## Before the interview

- Run `npm test` and `npm run check` on your own machine.
- Deploy from your GitHub repository, open the public URL in a private window, and verify `/api/health` plus the demo.
- Read `app/src/checker.js`, at least one DNS test, and `docs/SMTP.md`. Be able to trace one address from input through the API to its result.
- Generate the submission sheet with the real live and repository links, save it as PDF, and click both links from the PDF.
- Describe the project as an internship submission. Avoid invented claims about production users, accuracy percentages, customers, or employment at Shieldnix.
