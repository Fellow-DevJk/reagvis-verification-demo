const API_BASE = window.REAGVIS_DEMO_API_BASE || "https://rijbyw9mdd.execute-api.ap-south-1.amazonaws.com";
const DEFAULT_TENANT = "meridian-bank";
const VIEWS = ["applicant", "overview", "trace", "providers", "verifications", "webhooks", "sandbox", "audit", "queue"];
const TERMINAL = ["verified", "failed", "requires_review", "expired", "cancelled"];

const state = {
  view: "applicant",
  step: "start",
  provider: "digilocker",
  upload: null,
  latestVerification: null,
  selectedVerification: null,
  providerFocus: null,
  filterStatus: "all",
};

const providers = {
  digilocker: {
    label: "DigiLocker",
    short: "DL",
    accent: "blue",
    description: "OAuth-style consent, callback correlation, document retrieval, and normalized result on the DigiLocker rail.",
    rails: ["Create Reagvis verification", "Generate state", "Receive callback", "Normalize documents"],
    config: ["OAuth callback", "State validation", "Token exchange interface", "Document normalizer"],
  },
  aadhaar_ekyc: {
    label: "Aadhaar e-KYC",
    short: "AE",
    accent: "violet",
    description: "OTP/authentication, ASA/KSA transport boundary, UIDAI response handling, and normalized identity result.",
    rails: ["Create Reagvis verification", "Build auth request", "Receive provider response", "Normalize identity"],
    config: ["AUA/KUA adapter", "Certificate abstraction", "ASA/KSA transport", "Response validator"],
  },
  document_upload: {
    label: "Manual upload",
    short: "UP",
    accent: "lime",
    description: "Browser-side intake checks before the document is submitted into the verification lifecycle.",
    rails: ["Check file size/type", "Check file signature", "Estimate image quality", "Submit for processing"],
    config: ["Format gate", "Signature sniffing", "Quality heuristics", "Review routing"],
  },
};

const scenarios = [
  ["success", "Clean verification", "Provider returns usable identity data and the result is delivered."],
  ["document_blurry", "Borderline upload", "Quality checks allow submission but route the case to review."],
  ["suspected_fake", "Suspected forged document", "Forensic signal crosses the review threshold."],
  ["needs_manual_review", "Policy review", "Document is readable but policy requires a human decision."],
  ["provider_timeout", "Provider timeout", "The provider does not respond before the retry window."],
  ["provider_unavailable", "Provider unavailable", "The upstream service fails fast."],
  ["aadhaar_auth_failed", "Aadhaar auth failed", "Identity authentication fails on the Aadhaar rail."],
  ["user_cancelled", "Applicant cancelled", "The applicant exits before completing consent."],
  ["expired", "Session expired", "The applicant does not return before the session expires."],
  ["bad_upload", "Upload rejected", "Hard intake checks stop processing."],
];

const hardFailIds = new Set(["size", "format", "signature", "decode", "blank"]);

function $(selector, root = document) {
  return root.querySelector(selector);
}

function $all(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

function cloneTemplate(id) {
  return document.importNode($(`#${id}`).content, true);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmtStatus(value) {
  return String(value || "unknown").replaceAll("_", " ").toUpperCase();
}

function setView(view) {
  state.view = VIEWS.includes(view) ? view : "applicant";
  $all(".view").forEach((node) => node.classList.toggle("active", node.id === state.view));
  $all("[data-view-link]").forEach((node) => node.classList.toggle("active", node.dataset.viewLink === state.view));
  refreshView(state.view);
}

async function refreshView(view) {
  if (view === "overview") return renderOverview();
  if (view === "trace") return renderTracePage();
  if (view === "providers") return renderProviders();
  if (view === "verifications") return renderVerifications();
  if (view === "webhooks") return renderWebhooks();
  if (view === "sandbox") return renderSandbox();
  if (view === "audit") return renderAudit();
  if (view === "queue") return renderQueue();
}

function renderStep(step = state.step) {
  state.step = step;
  const root = $("#phoneBody");
  root.innerHTML = "";

  if (step === "start") root.append(cloneTemplate("startTemplate"));
  if (step === "method") root.append(cloneTemplate("methodTemplate"));
  if (step === "upload") root.append(cloneTemplate("uploadTemplate"));

  if (step === "provider") {
    const fragment = cloneTemplate("providerTemplate");
    const provider = providers[state.provider];
    $("#providerTitle", fragment).textContent = provider.label;
    $("#providerDescription", fragment).textContent = provider.description;
    $("#providerRail", fragment).innerHTML = provider.rails
      .map((item, index) => `<div class="rail-item processing"><span class="dot"></span><span>${index + 1}. ${escapeHtml(item)}</span></div>`)
      .join("");
    root.append(fragment);
  }

  if (step === "result") {
    const fragment = cloneTemplate("resultTemplate");
    const record = state.latestVerification;
    const status = record?.status || "processing";
    const title = status === "verified" ? "Verification complete" : status === "requires_review" ? "Sent for review" : "Verification needs attention";
    const detail = record?.normalized_result?.checks || {};
    $("#resultTitle", fragment).textContent = title;
    $("#resultDescription", fragment).textContent = resultDescription(record);
    $("#resultCard", fragment).innerHTML = `
      <div class="validation-item ${status}">
        <span class="dot"></span>
        <span><strong>${fmtStatus(status)}</strong><br><code>${escapeHtml(record?.verification_id || "pending")}</code></span>
      </div>
      ${Object.entries(detail).map(([name, check]) => checkRow(name, check)).join("")}
    `;
    root.append(fragment);
    renderLiveTrace(record, $("#liveTrace"));
  }
}

function checkRow(name, check) {
  const tone = check.status === "passed" ? "pass" : check.status === "needs_review" ? "warn" : check.status === "skipped" ? "processing" : "fail";
  return `
    <div class="validation-item ${tone}">
      <span class="dot"></span>
      <span><strong>${escapeHtml(name.replaceAll("_", " "))}</strong><br>${escapeHtml(check.status)}${check.note ? ` - ${escapeHtml(check.note)}` : ""}</span>
    </div>
  `;
}

function resultDescription(record) {
  if (!record) return "Waiting for the backend to return the verification.";
  if (record.status === "verified") return "The customer dashboard receives a normalized verified result, independent of provider rail.";
  if (record.status === "requires_review") return "The applicant gets a calm review state while Reagvis operators see the queue item.";
  if (record.status === "failed") return "The failed state is explicit and can be shown without leaking provider-specific internals.";
  if (record.status === "expired") return "The verification expired and can be restarted using the same public lifecycle model.";
  if (record.status === "cancelled") return "The applicant cancelled before completion.";
  return "The verification is still moving through the common Reagvis lifecycle.";
}

async function checkHealth() {
  $("#apiEndpointLabel").textContent = API_BASE;
  $("#heroEndpoint").textContent = API_BASE;
  try {
    const res = await fetch(`${API_BASE}/health`);
    const body = await res.json();
    $("#healthLabel").textContent = body.ok ? "Online" : "Unhealthy";
  } catch {
    $("#healthLabel").textContent = "Offline";
  }
}

async function validateDocument(file) {
  const checks = [];
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const allowed = ["pdf", "jpg", "jpeg", "png"];

  checks.push({
    id: "size",
    label: "File size",
    status: file.size > 0 && file.size <= 50 * 1024 * 1024 ? "pass" : "fail",
    detail: `${(file.size / (1024 * 1024)).toFixed(2)} MB`,
  });
  checks.push({
    id: "format",
    label: "Allowed format",
    status: allowed.includes(ext) ? "pass" : "fail",
    detail: ext ? `.${ext}` : "missing extension",
  });

  const signature = await readSignature(file);
  const expected = signatureToType(signature);
  checks.push({
    id: "signature",
    label: "Extension vs signature",
    status: expected && typeMatchesExtension(expected, ext) ? "pass" : "fail",
    detail: expected ? `${expected} content` : "unknown content",
  });

  if (expected === "image") checks.push(...(await imageQualityChecks(file)));
  if (expected === "pdf") {
    checks.push({ id: "decode", label: "PDF decode", status: "pass", detail: "Header readable" });
    checks.push({ id: "ocr", label: "OCR readability", status: "warn", detail: "Deferred to server quality stage" });
  }

  const hardFailed = checks.some((check) => check.status === "fail" && hardFailIds.has(check.id));
  const warned = checks.some((check) => check.status === "warn");
  return { checks, hardFailed, warned, scenario: hardFailed ? "bad_upload" : warned ? "document_blurry" : "success" };
}

async function readSignature(file) {
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function signatureToType(hex) {
  if (hex.startsWith("25504446")) return "pdf";
  if (hex.startsWith("ffd8ff")) return "image";
  if (hex.startsWith("89504e470d0a1a0a")) return "image";
  return null;
}

function typeMatchesExtension(type, ext) {
  if (type === "pdf") return ext === "pdf";
  return ["jpg", "jpeg", "png"].includes(ext);
}

async function imageQualityChecks(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const brightness = estimateBrightness(image);
    const resolutionOk = image.naturalWidth >= 900 && image.naturalHeight >= 600;
    return [
      { id: "resolution", label: "Resolution", status: resolutionOk ? "pass" : "warn", detail: `${image.naturalWidth} x ${image.naturalHeight}` },
      { id: "brightness", label: "Brightness", status: brightness > 45 && brightness < 225 ? "pass" : "warn", detail: `${Math.round(brightness)} / 255 average` },
      { id: "blur", label: "Blur / focus", status: resolutionOk ? "pass" : "warn", detail: "Resolution proxy" },
      { id: "glare", label: "Glare", status: brightness < 215 ? "pass" : "warn", detail: "Brightness proxy" },
    ];
  } catch {
    return [{ id: "decode", label: "Image decode", status: "fail", detail: "Could not decode image" }];
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

function estimateBrightness(image) {
  const canvas = document.createElement("canvas");
  const size = 96;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  let total = 0;
  for (let index = 0; index < data.length; index += 4) {
    total += 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
  }
  return total / (data.length / 4);
}

function renderValidation(result) {
  $("#validationResults").innerHTML = `
    ${result.checks.map((check) => `
      <div class="validation-item ${check.status}">
        <span class="dot"></span>
        <span><strong>${escapeHtml(check.label)}</strong><br>${escapeHtml(check.detail)}</span>
      </div>
    `).join("")}
    ${result.hardFailed ? `<div class="validation-item fail"><span class="dot"></span><span><strong>Submission blocked</strong><br>Choose another file or run this outcome from Sandbox.</span></div>` : ""}
  `;
  $("#submitUploadButton").disabled = result.hardFailed;
}

async function createVerification({ provider, scenario, metadata = {} }) {
  const res = await fetch(`${API_BASE}/v1/verifications`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tenant_id: DEFAULT_TENANT,
      provider,
      scenario,
      customer_reference: `MB-${String(Date.now()).slice(-5)}`,
      checks: provider === "document_upload" ? ["identity", "document"] : ["identity"],
      metadata,
    }),
  });
  if (!res.ok) throw new Error(`Create failed: ${res.status} ${await res.text()}`);
  const created = await res.json();
  return pollVerification(created.verification_id);
}

async function pollVerification(id) {
  let latest = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const res = await fetch(`${API_BASE}/v1/verifications/${id}`);
    latest = await res.json();
    if (TERMINAL.includes(latest.status)) return latest;
    await delay(900);
  }
  return latest;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runApplicantScenario(provider, scenario, metadata = {}) {
  state.provider = provider;
  renderStep(provider === "document_upload" ? "upload" : "provider");
  state.latestVerification = await createVerification({ provider, scenario, metadata });
  state.selectedVerification = state.latestVerification;
  renderStep("result");
  await refreshCurrentDashboards();
}

function renderLiveTrace(record = state.latestVerification, root = $("#liveTrace")) {
  if (!root) return;
  if (!record) {
    root.innerHTML = `
      <div class="trace-strip">${traceLabels("digilocker").map((label, index) => traceNode(label, index, "created")).join("")}</div>
      <div class="trace-footer"><strong>Total --</strong><span>Run or open a verification to see trace events.</span><span class="pill">READY</span></div>
    `;
    return;
  }

  const traceEvents = record.trace_events || [];
  root.innerHTML = `
    <div class="trace-strip">
      ${traceLabels(record.provider).map((label, index) => traceNode(label, index, index === 6 ? "delivery" : record.status)).join("")}
    </div>
    <div class="trace-footer">
      <strong>${durationLabel(record)}</strong>
      <span>${escapeHtml(traceSummary(record))}</span>
      <span class="pill">${fmtStatus(record.status)}</span>
    </div>
    <div class="dashboard-card">
      <h3>State</h3>
      <div class="table">${traceEvents.map((event) => row(event.event, event.state, event.occurred_at?.slice(11, 23) || "", { compact: true })).join("")}</div>
    </div>
  `;
}

function traceLabels(provider) {
  if (provider === "digilocker") return ["Customer App", "Reagvis API", "Verification Engine", "DigiLocker Adapter", "DigiLocker", "Normalized Result", "Webhook"];
  if (provider === "aadhaar_ekyc") return ["Customer App", "Reagvis API", "Verification Engine", "AUA/KUA Adapter", "ASA/KSA", "Normalized Result", "Webhook"];
  return ["Customer App", "Reagvis API", "Verification Engine", "Upload Intake", "Document Processor", "Normalized Result", "Webhook"];
}

function traceNode(label, index, status) {
  const tag = ["origin", "ingress", "routing", "adapter", "provider", "egress", "delivery"][index] || "step";
  const className = index === 6 ? "delivery" : status === "failed" || status === "requires_review" ? status : "";
  return `<div class="trace-node ${className}"><small>${tag}</small><strong>${escapeHtml(label)}</strong></div>`;
}

function traceSummary(record) {
  if (record.status === "verified") return "Routed through provider, normalized, and delivered to the customer dashboard.";
  if (record.status === "requires_review") return "Routed into the operator queue with audit trail and customer-visible review state.";
  if (record.status === "failed") return `Provider or intake failure captured as ${record.failure_code || "failed"}.`;
  if (record.status === "cancelled") return "Applicant cancellation captured without corrupting the lifecycle.";
  return "Verification is moving through the common lifecycle.";
}

function durationLabel(record) {
  if (!record.completed_at) return "Total --";
  const ms = Date.parse(record.completed_at) - Date.parse(record.created_at);
  return `Total ${(ms / 1000).toFixed(2)}s`;
}

async function renderOverview() {
  const root = $("#overviewDashboard");
  root.innerHTML = loading("Loading overview...");
  const data = await fetchJson("/v1/dashboard/client");
  root.innerHTML = `
    <div class="kpi-grid">
      ${kpi("Verifications", data.summary.total, "All sandbox requests accepted")}
      ${kpi("Verified", data.summary.verified, "Normalized result delivered")}
      ${kpi("Review", data.summary.requires_review, "Human decision required")}
      ${kpi("Active providers", data.provider_health.filter((p) => p.status === "operational").length, "Rails configured")}
    </div>
    <div class="dashboard-card lifecycle-card">
      <h3>Verification lifecycle</h3>
      ${lifecycleBar(data.summary)}
      <div class="mini-grid">
        ${miniStat("Created", data.summary.total)}
        ${miniStat("Processing", data.summary.processing)}
        ${miniStat("Failed", data.summary.failed)}
        ${miniStat("Cancelled", data.summary.cancelled)}
      </div>
    </div>
    <div class="split-grid">
      <div class="dashboard-card">
        <h3>Provider health</h3>
        <div class="table">${data.provider_health.map(providerHealthRow).join("")}</div>
      </div>
      <div class="dashboard-card">
        <h3>Recent verifications</h3>
        <div class="table">${data.recent_verifications.slice(0, 6).map(verificationRow).join("")}</div>
      </div>
    </div>
  `;
}

async function renderTracePage() {
  const root = $("#traceDashboard");
  root.innerHTML = loading("Loading trace...");
  const record = await ensureSelectedVerification();
  root.innerHTML = `<div id="tracePageBody"></div>`;
  renderLiveTrace(record, $("#tracePageBody"));
}

async function renderProviders() {
  const root = $("#providersDashboard");
  root.innerHTML = loading("Loading providers...");
  const data = await fetchJson("/v1/dashboard/client");
  root.innerHTML = `
    <div class="provider-grid">
      ${data.provider_health.map((item) => providerCard(item)).join("")}
    </div>
    <div class="dashboard-card">
      <h3>${escapeHtml(providers[state.providerFocus || "digilocker"].label)} configuration</h3>
      <div class="check-grid">${providers[state.providerFocus || "digilocker"].config.map((item) => `<div class="validation-item pass"><span class="dot"></span><span>${escapeHtml(item)}</span></div>`).join("")}</div>
    </div>
  `;
}

async function renderVerifications() {
  const root = $("#verificationsDashboard");
  root.innerHTML = loading("Loading verifications...");
  const data = await fetchJson("/v1/verifications");
  const shown = state.filterStatus === "all"
    ? data.verifications
    : data.verifications.filter((item) => item.status === state.filterStatus);
  root.innerHTML = `
    <div class="dashboard-card">
      <h3>All sessions</h3>
      <div class="filter-row">
        ${["all", "verified", "requires_review", "failed", "cancelled"].map((status) => `<button class="ghost ${state.filterStatus === status ? "active-filter" : ""}" data-filter-status="${status}">${fmtStatus(status)}</button>`).join("")}
      </div>
      <div class="table verification-table" id="verificationTable">
        ${shown.map(verificationRow).join("") || row("No sessions match this filter", state.filterStatus, "")}
      </div>
    </div>
  `;
}

async function renderWebhooks() {
  const root = $("#webhooksDashboard");
  root.innerHTML = loading("Loading webhooks...");
  const data = await fetchJson("/v1/dashboard/client");
  root.innerHTML = `
    <div class="kpi-grid">
      ${kpi("Deliveries", data.webhook_deliveries.length, "Recent attempts")}
      ${kpi("Delivered", data.webhook_deliveries.filter((d) => d.status === "delivered").length, "Customer received")}
      ${kpi("Retries", data.webhook_deliveries.filter((d) => d.status === "retry_scheduled").length, "Backoff scheduled")}
      ${kpi("Endpoint", "1", "customer.example")}
    </div>
    <div class="dashboard-card">
      <h3>Delivery log</h3>
      <div class="table">${data.webhook_deliveries.map((item) => webhookRow(item)).join("")}</div>
    </div>
  `;
}

function renderSandbox() {
  const root = $("#sandboxDashboard");
  root.innerHTML = `
    <div class="dashboard-card">
      <h3>Create verification</h3>
      <p class="muted-copy">These buttons call the live sandbox API and create real demo records in DynamoDB.</p>
      <div class="scenario-grid">
        ${scenarios.map(([id, title, desc]) => `
          <button class="scenario-card" data-sandbox-run="${id}">
            <strong>${escapeHtml(title)}</strong>
            <small>${escapeHtml(desc)}</small>
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

async function renderAudit() {
  const root = $("#auditDashboard");
  root.innerHTML = loading("Loading audit log...");
  const data = await fetchJson("/v1/dashboard/operator");
  root.innerHTML = `
    <div class="dashboard-card">
      <h3>Audit events</h3>
      <div class="table">${data.audit_events.map((item) => row(item.event, item.provider, item.occurred_at?.replace("T", " ").replace("Z", ""), { action: item.verification_id })).join("")}</div>
    </div>
  `;
}

async function renderQueue() {
  const root = $("#queueDashboard");
  root.innerHTML = loading("Loading review queue...");
  const data = await fetchJson("/v1/dashboard/operator");
  root.innerHTML = `
    <div class="split-grid queue-grid">
      <div class="dashboard-card">
        <h3>Needs review</h3>
        <div class="table">${data.queue.length ? data.queue.map((item) => queueRow(item)).join("") : row("Queue empty", "no holds", "healthy")}</div>
      </div>
      <div class="dashboard-card case-preview">
        <h3>Case preview</h3>
        ${casePreview(data.queue[0])}
      </div>
    </div>
  `;
}

function kpi(label, value, note = "") {
  return `<div class="dashboard-card kpi"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong><span>${escapeHtml(note)}</span></div>`;
}

function miniStat(label, value) {
  return `<div class="mini-stat"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></div>`;
}

function lifecycleBar(summary) {
  const total = Math.max(summary.total || 0, 1);
  const parts = [
    ["created", summary.total || 0, "var(--blue)"],
    ["review", summary.requires_review || 0, "var(--amber)"],
    ["failed", summary.failed || 0, "var(--coral)"],
    ["verified", summary.verified || 0, "var(--lime)"],
  ];
  return `<div class="lifecycle-bar">${parts.map(([, n, color]) => `<span style="width:${(n / total) * 100}%;background:${color}"></span>`).join("")}</div>`;
}

function row(a, b, c, options = {}) {
  const attrs = options.action ? ` role="button" tabindex="0" data-open-verification="${escapeHtml(options.action)}"` : "";
  const compact = options.compact ? " compact-row" : "";
  return `<div class="row${compact}"${attrs}><span>${escapeHtml(a)}</span><small>${escapeHtml(b)}</small><code>${escapeHtml(c)}</code></div>`;
}

function verificationRow(item) {
  return row(item.verification_id, `${providerLabel(item.provider)} · ${item.customer_reference}`, fmtStatus(item.status), { action: item.verification_id });
}

function providerHealthRow(item) {
  return `<div class="row" role="button" tabindex="0" data-provider-detail="${escapeHtml(item.provider)}"><span>${escapeHtml(item.label)}</span><small>${item.mode === "mock" ? "Sandbox" : escapeHtml(item.mode)}</small><code>${escapeHtml(item.volume)} sessions</code></div>`;
}

function providerCard(item) {
  const meta = providers[item.provider] || providers.digilocker;
  return `
    <button class="provider-card ${meta.accent}" data-provider-detail="${escapeHtml(item.provider)}">
      <span>${escapeHtml(meta.short)}</span>
      <strong>${escapeHtml(item.label)}</strong>
      <small>${item.mode === "mock" ? "Sandbox rail" : escapeHtml(item.mode)} · ${escapeHtml(item.volume)} sessions · ${escapeHtml(item.median_latency_ms)}ms median</small>
    </button>
  `;
}

function webhookRow(item) {
  return row(item.event, `${item.status} · ${item.attempts} attempt${item.attempts === 1 ? "" : "s"}`, item.verification_id, { action: item.verification_id });
}

function queueRow(item) {
  return row(item.verification_id, `${providerLabel(item.provider)} · ${item.reason}`, fmtStatus(item.status), { action: item.verification_id });
}

function casePreview(item) {
  if (!item) return `<p class="muted-copy">No manual review cases are waiting.</p>`;
  return `
    <div class="doc-preview">
      <div class="doc-card">
        <span></span>
        <strong>Document image</strong>
        <small>Quality warning overlay</small>
      </div>
      <div>
        <p><strong>${escapeHtml(item.customer_reference)}</strong></p>
        <p class="muted-copy">${escapeHtml(providerLabel(item.provider))} · ${escapeHtml(item.scenario)}</p>
        <div class="decision-row">
          <button class="primary" data-review-decision="approved" data-review-id="${escapeHtml(item.verification_id)}">Approve</button>
          <button class="ghost" data-review-decision="rejected" data-review-id="${escapeHtml(item.verification_id)}">Reject</button>
        </div>
        <p id="reviewActionNote" class="muted-copy">Decision writes to the sandbox backend and updates the queue.</p>
      </div>
    </div>
  `;
}

function providerLabel(provider) {
  return providers[provider]?.label || provider;
}

function loading(text) {
  return `<div class="dashboard-card">${escapeHtml(text)}</div>`;
}

async function ensureSelectedVerification() {
  if (state.selectedVerification?.trace_events) return state.selectedVerification;
  if (state.latestVerification?.trace_events) return state.latestVerification;
  const data = await fetchJson("/v1/verifications");
  const first = data.verifications?.[0];
  if (!first) return null;
  return openVerification(first.verification_id, { silent: true });
}

async function openVerification(id, options = {}) {
  const record = await fetchJson(`/v1/verifications/${encodeURIComponent(id)}`);
  state.selectedVerification = record;
  state.latestVerification = record;
  if (!options.silent) renderDrawer(record);
  return record;
}

function renderDrawer(record) {
  const drawer = $("#detailDrawer");
  const checks = record.normalized_result?.checks || {};
  drawer.classList.add("open");
  drawer.innerHTML = `
    <button class="drawer-close" id="drawerCloseButton">Close</button>
    <span class="eyebrow">Verification detail</span>
    <h2>${escapeHtml(record.customer_reference)}</h2>
    <div class="validation-item ${record.status}"><span class="dot"></span><span><strong>${fmtStatus(record.status)}</strong><br><code>${escapeHtml(record.verification_id)}</code></span></div>
    <div class="drawer-actions">
      <button class="primary" data-go-trace="${escapeHtml(record.verification_id)}">Open trace</button>
      <button class="ghost" data-copy-id="${escapeHtml(record.verification_id)}">Copy ID</button>
    </div>
    ${record.status === "requires_review" ? `
      <div class="decision-row">
        <button class="primary" data-review-decision="approved" data-review-id="${escapeHtml(record.verification_id)}">Approve review</button>
        <button class="ghost" data-review-decision="rejected" data-review-id="${escapeHtml(record.verification_id)}">Reject review</button>
      </div>
    ` : ""}
    <h3>Normalized result</h3>
    <div class="result-card">${Object.entries(checks).map(([name, check]) => checkRow(name, check)).join("") || "<p>No terminal result yet.</p>"}</div>
    <h3>Provider transaction</h3>
    <pre>${escapeHtml(JSON.stringify({
      provider: record.provider,
      scenario: record.scenario,
      provider_transaction_id: record.provider_transaction_id,
      failure_code: record.failure_code,
    }, null, 2))}</pre>
    <h3>Trace events</h3>
    <div class="table">${(record.trace_events || []).map((event) => row(event.event, event.state, event.occurred_at?.slice(11, 23) || "", { compact: true })).join("")}</div>
    <h3>Webhook deliveries</h3>
    <div class="table">${(record.webhook_deliveries || []).map(webhookRow).join("")}</div>
  `;
}

async function seedDemo() {
  const res = await fetch(`${API_BASE}/v1/demo/seed`, { method: "POST", headers: { "content-type": "application/json" } });
  if (!res.ok) throw new Error(`Seed failed: ${res.status}`);
  const body = await res.json();
  state.latestVerification = body.verifications?.[0] || null;
  state.selectedVerification = state.latestVerification;
  renderStep("result");
  setView("overview");
}

async function resetDemo() {
  const res = await fetch(`${API_BASE}/v1/demo/reset`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Reset failed: ${res.status}`);
  state.latestVerification = null;
  state.selectedVerification = null;
  state.upload = null;
  renderStep("start");
  renderLiveTrace(null, $("#liveTrace"));
  await refreshCurrentDashboards();
}

async function submitReviewDecision(id, decision) {
  const res = await fetch(`${API_BASE}/v1/verifications/${encodeURIComponent(id)}/review-decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      decision,
      reviewed_by: "demo-reviewer",
      note: decision === "approved" ? "Approved from Reagvis console." : "Rejected from Reagvis console.",
    }),
  });
  if (!res.ok) throw new Error(`Review decision failed: ${res.status} ${await res.text()}`);
  const record = await res.json();
  state.selectedVerification = record;
  state.latestVerification = record;
  renderDrawer(record);
  if (state.view === "trace") renderLiveTrace(record, $("#tracePageBody"));
  await refreshCurrentDashboards();
  return record;
}

async function refreshCurrentDashboards() {
  await Promise.all([
    state.view === "overview" ? renderOverview() : Promise.resolve(),
    state.view === "trace" ? renderTracePage() : Promise.resolve(),
    state.view === "providers" ? renderProviders() : Promise.resolve(),
    state.view === "verifications" ? renderVerifications() : Promise.resolve(),
    state.view === "webhooks" ? renderWebhooks() : Promise.resolve(),
    state.view === "audit" ? renderAudit() : Promise.resolve(),
    state.view === "queue" ? renderQueue() : Promise.resolve(),
  ]);
}

async function fetchJson(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

document.addEventListener("click", async (event) => {
  const next = event.target.closest("[data-next-step]");
  if (next) renderStep(next.dataset.nextStep);

  const providerButton = event.target.closest("[data-provider]");
  if (providerButton) {
    state.provider = providerButton.dataset.provider;
    renderStep(state.provider === "document_upload" ? "upload" : "provider");
  }

  const quick = event.target.closest("[data-quick-run]");
  if (quick) {
    const scenario = quick.dataset.quickRun;
    const provider = scenario.startsWith("aadhaar") ? "aadhaar_ekyc" : scenario === "document_blurry" ? "document_upload" : "digilocker";
    quick.disabled = true;
    try {
      await runApplicantScenario(provider, scenario, { source: "quick-run" });
      setView("applicant");
    } finally {
      quick.disabled = false;
    }
  }

  const sandboxRun = event.target.closest("[data-sandbox-run]");
  if (sandboxRun) {
    sandboxRun.disabled = true;
    const scenario = sandboxRun.dataset.sandboxRun;
    const provider = scenario.startsWith("aadhaar") ? "aadhaar_ekyc" : ["document_blurry", "bad_upload", "needs_manual_review", "suspected_fake"].includes(scenario) ? "document_upload" : "digilocker";
    try {
      const record = await createVerification({ provider, scenario, metadata: { source: "sandbox" } });
      renderDrawer(record);
      setView("trace");
    } finally {
      sandboxRun.disabled = false;
    }
  }

  const refresh = event.target.closest("[data-refresh-dashboard]");
  if (refresh) refreshView(refresh.dataset.refreshDashboard);

  const filter = event.target.closest("[data-filter-status]");
  if (filter) {
    state.filterStatus = filter.dataset.filterStatus;
    renderVerifications();
  }

  const open = event.target.closest("[data-open-verification]");
  if (open) openVerification(open.dataset.openVerification);

  const providerDetail = event.target.closest("[data-provider-detail]");
  if (providerDetail) {
    state.providerFocus = providerDetail.dataset.providerDetail;
    setView("providers");
  }

  const goTrace = event.target.closest("[data-go-trace]");
  if (goTrace) {
    await openVerification(goTrace.dataset.goTrace, { silent: true });
    location.hash = "#trace";
  }

  const copy = event.target.closest("[data-copy-id]");
  if (copy && navigator.clipboard) navigator.clipboard.writeText(copy.dataset.copyId);

  if (event.target.id === "drawerCloseButton") $("#detailDrawer").classList.remove("open");

  if (event.target.id === "resetFlowButton") {
    state.upload = null;
    state.latestVerification = null;
    renderStep("start");
    renderLiveTrace(null, $("#liveTrace"));
  }

  if (event.target.id === "seedDemoButton" || event.target.id === "sandboxSeedButton") {
    event.target.disabled = true;
    try {
      await seedDemo();
    } finally {
      event.target.disabled = false;
    }
  }

  if (event.target.id === "resetDemoButton") {
    event.target.disabled = true;
    try {
      await resetDemo();
      setView("applicant");
    } finally {
      event.target.disabled = false;
    }
  }

  if (event.target.id === "replayLatestButton" || event.target.id === "traceReplayButton") {
    renderLiveTrace(state.selectedVerification || state.latestVerification, state.view === "trace" ? $("#tracePageBody") : $("#liveTrace"));
  }

  if (event.target.id === "providerSubmitButton") {
    event.target.disabled = true;
    try {
      await runApplicantScenario(state.provider, "success", { source: "provider-flow" });
    } finally {
      event.target.disabled = false;
    }
  }

  if (event.target.id === "submitUploadButton" && state.upload) {
    event.target.disabled = true;
    try {
      await runApplicantScenario("document_upload", state.upload.scenario, {
        filename: state.upload.file.name,
        browser_quality_result: state.upload.warned ? "warning" : "pass",
      });
    } finally {
      event.target.disabled = false;
    }
  }

  const reviewDecision = event.target.closest("[data-review-decision]");
  if (reviewDecision) {
    reviewDecision.disabled = true;
    const note = $("#reviewActionNote");
    if (note) note.textContent = "Submitting decision...";
    try {
      await submitReviewDecision(reviewDecision.dataset.reviewId, reviewDecision.dataset.reviewDecision);
      if (note) note.textContent = "Decision saved.";
    } catch (err) {
      if (note) note.textContent = err.message;
    } finally {
      reviewDecision.disabled = false;
    }
  }
});

document.addEventListener("change", async (event) => {
  if (event.target.id !== "documentFile") return;
  const file = event.target.files?.[0];
  if (!file) return;
  $("#validationResults").innerHTML = `<div class="validation-item processing"><span class="dot"></span><span>Running browser intake checks...</span></div>`;
  const result = await validateDocument(file);
  state.upload = { ...result, file };
  renderValidation(result);
});

window.addEventListener("hashchange", () => setView((location.hash || "#applicant").replace("#", "")));

renderStep("start");
setView((location.hash || "#applicant").replace("#", ""));
renderLiveTrace(null, $("#liveTrace"));
checkHealth();
