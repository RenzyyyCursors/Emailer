import { buildCsv } from "./csv.js";

const $ = (id) => document.getElementById(id);
const input = $("emails");
const labels = {
  delivered: "Likely delivered",
  bounce: "Likely bounce",
  unknown: "Unknown",
};
let results = [];
let metadata = { mode: "dns", checkedAt: "" };
let filter = "all";
let busy = false;
let expanded = new Set();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const tokens = (value) =>
  value.match(/"(?:[^"\\\r\n]|\\[^\r\n])*"@[^\s,;]+|[^\s,;]+/gu) || [];

function updateInput() {
  const count = tokens(input.value).length;
  $("input-count").textContent = `${count} address${count === 1 ? "" : "es"}`;
  $("verify").disabled = busy || count === 0 || count > 50;
  $("clear").disabled = busy || input.value.length === 0;
  if (count > 50)
    showError(`This list has ${count} addresses. Check up to 50 at a time.`);
  else showError("");
}

function showError(message) {
  $("input-error").textContent = message;
  $("input-error").hidden = !message;
}

function setFilter(value) {
  filter = value;
  document.querySelectorAll("[data-filter]").forEach((button) => {
    const selected = button.dataset.filter === value;
    button.setAttribute("aria-pressed", String(selected));
    if (button.classList.contains("filter-tab"))
      button.classList.toggle("selected", selected);
  });
  renderRows();
}

function renderRows() {
  if (!results.length) return;
  const query = $("search").value.trim().toLowerCase();
  const visible = results
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row }) =>
        (filter === "all" || row.status === filter) &&
        `${row.email} ${row.normalized} ${row.reason}`
          .toLowerCase()
          .includes(query),
    );
  const container = $("results-body");
  container.replaceChildren();
  if (!visible.length) {
    container.append(
      element("div", "no-results", "No addresses match this filter."),
    );
    return;
  }
  for (const { row, index } of visible) {
    const wrapper = element("article", "result-row");
    const toggle = element("button", "result-toggle");
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", String(expanded.has(index)));
    toggle.setAttribute("aria-controls", `detail-${index}`);
    toggle.setAttribute(
      "aria-label",
      `${row.email}: ${labels[row.status]}. ${row.reason} Show evidence.`,
    );
    const address = element("span", "address-info");
    address.append(
      element("span", "result-email", row.email),
      element("span", "result-reason", row.reason),
    );
    const badge = element("span", `result-badge ${row.status}`);
    badge.append(
      element("span", `result-dot ${row.status}`),
      document.createTextNode(labels[row.status]),
    );
    const chevron = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    chevron.setAttribute("viewBox", "0 0 24 24");
    chevron.setAttribute("class", "chevron");
    chevron.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "m6 9 6 6 6-6");
    chevron.append(path);
    toggle.append(address, badge, chevron);
    const detail = element("div", "result-detail");
    detail.id = `detail-${index}`;
    detail.hidden = !expanded.has(index);
    const checks = element("div", "check-list");
    for (const [key, name] of [
      ["syntax", "Address syntax"],
      ["domain", "Domain lookup"],
      ["mail", "Mail routing"],
      ["mailbox", "Mailbox acceptance"],
    ]) {
      const state = row.checks[key];
      const signal = element("span", "check-signal");
      const symbol = element(
        "span",
        `check-state ${state}`,
        state === "pass" ? "✓" : state === "fail" ? "×" : "?",
      );
      signal.append(
        symbol,
        document.createTextNode(
          `${name}: ${state === "pass" ? "passed" : state === "fail" ? "failed" : "unconfirmed"}`,
        ),
      );
      checks.append(signal);
    }
    detail.append(element("p", "full-reason", row.reason), checks);
    if (row.normalized !== row.email)
      detail.append(element("div", "", `Normalized: ${row.normalized}`));
    if (row.mx.length)
      detail.append(
        element("div", "", "Mail servers (priority, hostname)"),
        element(
          "span",
          "mx-list",
          row.mx.map((mx) => `${mx.priority}  ${mx.host}`).join(" · "),
        ),
      );
    detail.append(element("span", "detail-code", `Evidence code: ${row.code}`));
    if (row.status === "delivered")
      detail.append(
        element(
          "div",
          "",
          "Acceptance is a positive signal, not a delivery guarantee. Catch-all behavior is untested.",
        ),
      );
    toggle.addEventListener("click", () => {
      if (expanded.has(index)) expanded.delete(index);
      else expanded.add(index);
      const open = expanded.has(index);
      toggle.setAttribute("aria-expanded", String(open));
      detail.hidden = !open;
    });
    wrapper.append(toggle, detail);
    container.append(wrapper);
  }
}

function renderResults(payload) {
  results = payload.results;
  metadata = { mode: payload.mode, checkedAt: payload.checkedAt };
  expanded = new Set();
  $("search").value = "";
  $("search").disabled = false;
  $("export").disabled = false;
  $("result-count").textContent = String(results.length);
  for (const status of ["delivered", "bounce", "unknown"])
    $("count-" + status).textContent = String(
      results.filter((row) => row.status === status).length,
    );
  $("demo-banner").hidden = !payload.simulated;
  const duration =
    payload.durationMs < 1000
      ? `${payload.durationMs} ms`
      : `${(payload.durationMs / 1000).toFixed(1)} s`;
  $("run-meta").textContent = payload.simulated
    ? `${results.length} fictional addresses · simulated`
    : `${results.length} checked · ${duration} · ${new Date(payload.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  $("footer-mode").textContent = payload.simulated
    ? "Demo evidence only"
    : payload.mode === "local-smtp"
      ? "Owned addresses only"
      : "No mailbox probing";
  $("announcement").textContent =
    `${payload.simulated ? "Simulated demo. " : "Check complete. "}${results.length} results: ${results.filter((r) => r.status === "delivered").length} likely delivered, ${results.filter((r) => r.status === "bounce").length} likely bounce, ${results.filter((r) => r.status === "unknown").length} unknown.`;
  setFilter("all");
}

async function run(demo = false) {
  if (busy) return;
  if (!demo && (!tokens(input.value).length || tokens(input.value).length > 50))
    return updateInput();
  busy = true;
  showError("");
  const previous = $("results-body").cloneNode(true);
  $("results-body").replaceChildren();
  const loading = element("div", "loading-state");
  loading.append(
    element("span", "spinner"),
    element(
      "span",
      "",
      demo ? "Loading simulated evidence…" : "Reading the signals…",
    ),
    element("span", "stat-detail", "No email is being sent."),
  );
  $("results-body").append(loading);
  document.querySelector(".results-card").setAttribute("aria-busy", "true");
  $("verify").classList.add("loading");
  $("verify").querySelector("span").textContent = "Checking…";
  input.disabled = true;
  $("demo").disabled = true;
  $("export").disabled = true;
  $("search").disabled = true;
  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.disabled = true;
  });
  updateInput();
  let succeeded = false;
  try {
    const response = await fetch(demo ? "/api/demo" : "/api/check", {
      method: demo ? "GET" : "POST",
      ...(demo
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: input.value }),
          }),
      signal: AbortSignal.timeout(27_000),
    });
    const payload = await response.json();
    if (!response.ok)
      throw new Error(
        payload.error || "The check could not finish. Please try again.",
      );
    if (!Array.isArray(payload.results))
      throw new Error(
        "The server returned an unexpected response. Please retry.",
      );
    if (demo) input.value = payload.results.map((row) => row.email).join("\n");
    renderResults(payload);
    succeeded = true;
  } catch (error) {
    showError(
      error.name === "TimeoutError" || error.name === "AbortError"
        ? "The request timed out. Retry with a smaller list; a timeout does not mean a bounce."
        : error instanceof TypeError
          ? "Cannot reach the API. Make sure the server is running and retry."
          : error.message,
    );
    $("announcement").textContent =
      "The check could not finish. See the message below your list.";
    if (results.length) renderRows();
    else $("results-body").replaceChildren(...previous.childNodes);
  } finally {
    busy = false;
    input.disabled = false;
    $("demo").disabled = false;
    $("export").disabled = !results.length;
    $("search").disabled = !results.length;
    document.querySelectorAll("[data-filter]").forEach((button) => {
      button.disabled = false;
    });
    $("verify").classList.remove("loading");
    $("verify").querySelector("span").textContent = "Check addresses";
    document.querySelector(".results-card").setAttribute("aria-busy", "false");
    // Do not erase a network error while refreshing button states.
    const errorText = $("input-error").textContent;
    updateInput();
    if (!succeeded && errorText) showError(errorText);
  }
}

input.addEventListener("input", () => {
  updateInput();
  if (results.length)
    $("run-meta").textContent = "List changed · run a new check";
});
$("verify").addEventListener("click", () => run());
input.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    run();
  }
});
$("demo").addEventListener("click", () => run(true));
$("clear").addEventListener("click", () => {
  input.value = "";
  updateInput();
  input.focus();
  if (results.length)
    $("run-meta").textContent = "Previous results · list cleared";
});
$("search").addEventListener("input", renderRows);
document
  .querySelectorAll("[data-filter]")
  .forEach((button) =>
    button.addEventListener("click", () => setFilter(button.dataset.filter)),
  );
$("export").addEventListener("click", () => {
  const blob = new Blob([buildCsv(results, metadata)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = element("a");
  link.href = url;
  link.download = `mailsignal-${metadata.mode === "demo" ? "SIMULATED-" : ""}${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $("announcement").textContent =
    "CSV exported. It contains every result, including any rows hidden by filters.";
});

function openInfo(privacy = false) {
  $("dialog-title").textContent = privacy
    ? "Your list stays your list."
    : "Good signals. Honest limits.";
  const content = $("dialog-content");
  content.replaceChildren();
  const paragraphs = privacy
    ? [
        "Your full list is sent to this app’s server over the same-origin API. The application does not save addresses, use analytics, or keep a history in your browser.",
        "Only domain names and mail-server hostnames are queried through Cloudflare DNS over HTTPS. The local part of an address is not included in DNS requests. Cloudflare and your hosting provider apply their own infrastructure policies.",
        "In optional local SMTP mode, only exact addresses declared as owned by the operator can be checked with a mail server. No message or DATA command is sent. Exported CSV files are saved on your device.",
      ]
    : [
        "Likely bounce means there is specific negative evidence: invalid syntax, a nonexistent domain, Null MX, no usable mail route, or a definitive mailbox-not-found reply in local SMTP mode.",
        "Unknown is a useful result. Working DNS proves mail routing, not that a mailbox exists. DNS errors, timeouts, policy blocks, catch-all uncertainty, and unsupported address formats cannot establish a bounce.",
        "Likely delivered requires a mail server to accept the recipient during the optional local check. Even acceptance does not guarantee final delivery; catch-all behavior is not tested.",
        "The Vercel deployment uses DNS only because outbound SMTP port 25 is blocked. It intentionally returns Unknown for well-routed addresses. The simulated demo shows fictional examples of all three outcomes.",
      ];
  for (const text of paragraphs) content.append(element("p", "", text));
  $("info-dialog").showModal();
}
for (const id of ["how-nav", "mode-info", "learn-more"])
  $(id).addEventListener("click", () => openInfo());
$("privacy-info").addEventListener("click", () => openInfo(true));
$("close-dialog").addEventListener("click", () => $("info-dialog").close());
$("dialog-done").addEventListener("click", () => $("info-dialog").close());
$("info-dialog").addEventListener("click", (event) => {
  if (event.target === $("info-dialog")) $("info-dialog").close();
});

updateInput();
fetch("/api/health", { signal: AbortSignal.timeout(5000) })
  .then((response) => (response.ok ? response.json() : Promise.reject()))
  .then((health) => {
    $("mode-label").textContent = health.smtpEnabled
      ? "Local SMTP · owned only"
      : "DNS verification";
    $("footer-mode").textContent = health.smtpEnabled
      ? "Owned addresses only"
      : "No mailbox probing";
  })
  .catch(() => {
    $("mode-label").textContent = "API not connected";
  });
