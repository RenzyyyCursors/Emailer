# Publish MailSignal: GitHub → Render or Vercel

Both options run this application with real syntax and DNS checks. Both documented hosted modes are DNS-only: a valid mail route stays **unknown**, not a fabricated positive mailbox result. No paid API, database, SMTP password, or application secret is needed.

## 1. Check the local project

From the `Emailer` project folder:

```bash
npm run build
npm test
```

Both commands must pass. `npm start` runs the app at http://127.0.0.1:3000. Try a real DNS check and the separately labelled simulated demo.

## 2. Upload the latest files with GitHub Desktop

This folder is already a Git repository connected to [RenzyyyCursors/Emailer](https://github.com/RenzyyyCursors/Emailer). Continue using that repository.

1. Open GitHub Desktop and select **Emailer** in Current Repository. If it is not listed, use **File → Add Local Repository** and choose your existing `Emailer` folder.
2. Keep the current branch at **main**.
3. In **Changes**, review/select the project changes. `.gitignore` excludes `.env`, `node_modules/`, `.vercel/`, and temporary files; `.env.example` is intentionally included.
4. Enter a summary such as **Prepare Render and Vercel deployment** and click **Commit to main**.
5. Click **Push origin**. Committing saves locally; pushing uploads the commit to GitHub.
6. Click **View on GitHub**. Confirm the newest commit and these items exist at the repository's top level:

```text
README.md
package.json
.node-version
render.yaml
vercel.json
app/
api/
public/
scripts/
```

Use the repository root directly. Do not upload an extra parent folder that hides `package.json`, and do not upload only `public/`: the API/backend is required. If interviewers need public repository access, open the repository link in a private window and confirm they can view it.

Reference: [GitHub Desktop: committing and reviewing changes](https://docs.github.com/en/desktop/making-changes-in-a-branch/committing-and-reviewing-changes-to-your-project-in-github-desktop).

## 3A. Deploy on Render Free

1. Open the [Render dashboard](https://dashboard.render.com/), sign in, and choose **New → Web Service**. Choose **Web Service**, not Static Site: this project has a backend.
2. Select **Git Provider**, connect GitHub if necessary, and select **RenzyyyCursors/Emailer**. If GitHub asks which repositories Render may access, selecting this repository is sufficient.
3. Configure these values:

| Field | Value |
| --- | --- |
| Name | Any available service name, such as `mailsignal` |
| Language/runtime | **Node** |
| Branch | **main** |
| Region | Your preferred available region |
| Root Directory | **Leave blank** |
| Build Command | `npm run build && npm test` |
| Start Command | `npm start` |
| Instance Type | **Free** |
| Health Check Path (Advanced) | `/api/health` |
| Environment variables | **None to add** |

4. Click **Create Web Service** / the deploy button and watch the build logs. Build checks and tests should pass, followed by the server's `MailSignal is ready` message. Render supplies `PORT` and `RENDER`; the application handles them automatically. It also reads the committed `.node-version` file. Do not set `HOST=127.0.0.1` or add SMTP credentials.
5. Wait until Render reports the service is live. Copy the actual `https://…onrender.com` URL from the service page.
6. Follow the live verification steps below. Only a successful deployment and a working URL count as deployed; a build log alone is not enough.

An alternative is **New → Blueprint** using the committed `render.yaml`. It specifies a Node web service, Free plan, build/start commands, and health check. Use either the manual Web Service flow or the Blueprint flow; you do not need duplicate services.

Render Free sleeps after 15 idle minutes and can take about a minute to wake. Open the site and let it finish waking before testing. Free Render services block outbound SMTP ports 25, 465, and 587; this deployment intentionally keeps mailbox existence unknown. Those restrictions do not prevent HTTPS DNS verification.

Official references: [Web Services](https://render.com/docs/web-services), [Free limits](https://render.com/docs/free), [SMTP restrictions](https://render.com/changelog/free-web-services-will-no-longer-allow-outbound-traffic-to-smtp-ports), [Node version selection](https://render.com/docs/node-version), [Blueprint specification](https://render.com/docs/blueprint-spec).

## 3B. Deploy on Vercel instead

1. Open [Vercel New Project](https://vercel.com/new), sign in, and import **RenzyyyCursors/Emailer** from GitHub.
2. Choose **Other** as the Framework Preset. Keep the Root Directory at the repository root (`./`).
3. Use the settings below. The committed `vercel.json` supplies build/output configuration, so matching automatically detected values are fine.

| Field | Value |
| --- | --- |
| Framework Preset | **Other** |
| Root Directory | `./` |
| Build Command | `npm run build` |
| Output Directory | `public` |
| Node.js | Supported 24.x; the bounded package engine range supports this |
| Install Command | Leave the default; there are no app dependencies |
| Environment variables | **None to add** |
| Start Command | Not required; Vercel uses the root `api/` functions |

4. Click **Deploy** and wait for **Ready**.
5. Copy the public production domain listed under the project's **Domains**, usually `https://…vercel.app`. Use the stable production domain for the assignment, not an authenticated dashboard or preview URL.
6. Test it in a private browser window and run the verification command below. If it shows Vercel login instead of your app, check **Settings → Deployment Protection**. **Standard Protection** leaves the production domain public; **All Deployments** can protect it. Confirm the production domain is publicly accessible before submitting.

Vercel blocks receiving-mail-server connections on port 25, so its API adapter always uses DNS-only mode. Do not run `app/server.mjs` as a Vercel function; the root `api/` entry points already provide the serverless backend.

Official references: [Configure a build](https://vercel.com/docs/builds/configure-a-build), [Node.js functions](https://vercel.com/docs/functions/runtimes/node-js), [SMTP restrictions](https://vercel.com/kb/guide/serverless-functions-and-smtp), [Production protection scope](https://vercel.com/changelog/protect-production-deployments-for-free-on-every-plan).

## 4. Verify the public URL

Replace the example with the actual URL copied from your hosting dashboard:

```bash
npm run verify:deployment -- https://YOUR-SERVICE.onrender.com
# or
npm run verify:deployment -- https://YOUR-PROJECT.vercel.app
```

Run this command on your computer, inside the project folder. It verifies the page and browser modules, `/api/health`, the simulated demo, and actual syntax/DNS classification. It confirms DNS-only mode before making address checks and sends no email messages. If DNS cannot answer reliably, it reports failure with the observed evidence codes rather than claiming the deployment is fully verified.

Also test manually in a private browser window:

1. Open the public homepage. It must work without your hosting-account login.
2. Open `YOUR_LIVE_URL/api/health`. Expect JSON containing `"mode":"dns"`, `"smtpEnabled":false`, and `"sendsMessages":false`.
3. Paste the list below and click **Check addresses**:

```text
not-an-email
person@does-not-exist.invalid
team@example.com
check@gmail.com
```

| Input | Expected current result |
| --- | --- |
| `not-an-email` | Likely bounce: invalid syntax |
| `person@does-not-exist.invalid` | Likely bounce: nonexistent domain |
| `team@example.com` | Likely bounce: Null MX |
| `check@gmail.com` | Unknown: working domain route, unverified mailbox |

The latter is a DNS-only check of `gmail.com`, not a claim that `check@gmail.com` exists. Temporary resolver errors can instead produce unknown with a retry explanation.

4. Expand a row, use filters/search, and export CSV.
5. Run the simulated demo and confirm the simulation label. A demo positive is not evidence that a real mailbox was verified.

## 5. Prepare the PDF or DOCX submission

The assignment asks for **one PDF or DOCX containing the live application link and GitHub repository link**. A PDF is sufficient.

1. Replace the pending live-link line at the top of `README.md` with your working public URL.
2. Generate the submission sheet:

```bash
npm run submission -- --live YOUR_LIVE_HTTPS_URL --repo https://github.com/RenzyyyCursors/Emailer
```

3. Open `submission.html` in a browser. Use **Print → Save as PDF**. Save a name such as `MailSignal-Submission.pdf` and click both links in the resulting PDF.
4. Push your updated README and any final project changes using GitHub Desktop. Connected Render/Vercel projects normally redeploy when `main` is pushed; verify the newest deployment is healthy.
5. Submit the completed PDF. The included starter PDF is labelled deployment pending and must be replaced or completed first.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Render does not detect a listening port | Use the latest code, Node Web Service, `npm start`, and repository root. The server must use Render's `PORT` on `0.0.0.0`. |
| Render homepage loads, but checking returns 403 | Push the latest HTTPS-proxy fix, redeploy, and use the public HTTPS URL on the same domain as the frontend. |
| Vercel frontend works, `/api/health` returns 404 | Root must be `./`; confirm `api/` and `app/src/` were pushed alongside `public/`. |
| Service displays a hosting login page | Use the production domain and check deployment protection/public access. |
| Render first load is slow | Wait for the Free instance to wake, then rerun verification. |
| Every syntactically valid address has `dns_unavailable` | DNS HTTPS requests are failing or timing out. Check logs/connectivity; unknown does not mean the mailbox bounced. |
| Valid Gmail/Outlook addresses show unknown | Expected: healthy DNS cannot confirm a mailbox. |
| “10 checks in one minute” | Wait a minute. Quotas are best effort per instance; clients behind a proxy may share one. |
| Old behavior after a code change | Commit **and Push origin**, wait for the newest deployment to finish, and reload the browser. |

## Other suggested hosts

Railway [allows outbound SMTP only on Pro and above](https://docs.railway.com/networking/outbound-networking); Free, Trial, and Hobby do not solve the SMTP limitation. PythonAnywhere Free [restricts outbound access through an allowlist proxy](https://help.pythonanywhere.com/pages/403ForbiddenError/) and is not the straightforward deployment target for this Node backend. Moving hosts never guarantees mailbox verification: receiving mail servers can still hide existence or accept all recipients. These alternatives are not needed to submit an accurately documented DNS-only hosted version.
