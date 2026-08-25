const API_BASE = window.REAGVIS_DEMO_API_BASE || "https://rijbyw9mdd.execute-api.ap-south-1.amazonaws.com";
const DEFAULT_TENANT = "meridian-bank";

const state = {
  view: "applicant",
  step: "start",
  provider: "digilocker",
  upload: null,
  latestVerification: null,
};

const providers = {
  digilocker: {
    label: "DigiLocker",
    description: "OAuth-style consent, callback correlation, document retrieval, and normalized result on the DigiLocker rail.",
    rails: ["Create Reagvis verification", "Generate state", "Receive callback", "Normalize documents"],
  },
  aadhaar_ekyc: {
    label: "Aadhaar e-KYC",
    description: "OTP/authentication, ASA/KSA transport boundary, UIDAI response handling, and normalized identity result.",
    rails: ["Create Reagvis verification", "Build auth request", "Receive provider response", "Normalize identity"],
  },
  document_upload: {
    label: "Manual document upload",
    description: "Browser-side intake checks before the document is submitted into the verification lifecycle.",
    rails: ["Check file size/type", "Check file signature", "Estimate image quality", "Submit for processing"],
  },
};

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

function setView(view) {
  state.view = view;
  $all(".view").forEach((node) => node.classList.toggle("active", node.id === view));
  $all("[data-view-link]").forEach((node) => node.classList.toggle("active", node.dataset.viewLink === view));
  if (view === "client") refreshClientDashboard();
  if (view === "operator") refreshOperatorDashboard();
}

function renderStep(step = state.step) {
  state.step = step;
  const root = $("#phoneBody");
  root.innerHTML = "";

  if (step === "start") {
    root.append(cloneTemplate("startTemplate"));
  }

  if (step === "method") {
    root.append(cloneTemplate("methodTemplate"));
  }

  if (step === "upload") {
    root.append(cloneTemplate("uploadTemplate"));
  }

  if (step === "provider") {
    const fragment = cloneTemplate("providerTemplate");
    const provider = providers[state.provider];
    $("#providerTitle", fragment).textContent = provider.label;
    $("#providerDescription", fragment).textContent = provider.description;
    $("#providerRail", fragment).innerHTML = provider.rails
      .map((item, index) => `<div class="rail-item processing"><span class="dot"></span><span>${index + 1}. ${item}</span></div>`)
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
        <span><strong>${status.replaceAll("_", " ").toUpperCase()}</strong><br><code>${record?.verification_id || "pending"}</code></span>
      </div>
      ${Object.entries(detail)
        .map(
          ([name, check]) => `
            <div class="validation-item ${check.status === "passed" ? "pass" : check.status === "needs_review" ? "warn" : "fail"}">
              <span class="dot"></span>
              <span><strong>${name.replaceAll("_", " ")}</strong><br>${check.status}${check.note ? ` - ${check.note}` : ""}</span>
            </div>
          `,
        )
        .join("")}
    `;
    root.append(fragment);
    renderLiveTrace(record);
  }
}

function resultDescription(record) {
  if (!record) return "Waiting for the backend to return the verification.";
  if (record.status === "verified") return "The customer dashboard sees a normalized verified result, independent of provider rail.";
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
  } catch (err) {
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

  if (expected === "image") {
    checks.push(...(await imageQualityChecks(file)));
  } else if (expected === "pdf") {
    checks.push({ id: "decode", label: "PDF decode", status: "pass", detail: "Header readable" });
    checks.push({ id: "ocr", label: "OCR readability", status: "warn", detail: "Deferred to backend in this demo" });
  }

  const hardFailed = checks.some((check) => check.status === "fail" && hardFailIds.has(check.id));
  const warned = checks.some((check) => check.status === "warn");
  return {
    checks,
    hardFailed,
    warned,
    scenario: hardFailed ? "bad_upload" : warned ? "document_blurry" : "success",
  };
}

async function readSignature(file) {
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
    const checks = [
      {
        id: "resolution",
        label: "Resolution",
        status: image.naturalWidth >= 900 && image.naturalHeight >= 600 ? "pass" : "warn",
        detail: `${image.naturalWidth} x ${image.naturalHeight}`,
      },
    ];
    const brightness = estimateBrightness(image);
    checks.push({
      id: "brightness",
      label: "Brightness",
      status: brightness > 45 && brightness < 225 ? "pass" : "warn",
      detail: `${Math.round(brightness)} / 255 average`,
    });
    checks.push({ id: "blur", label: "Blur / focus", status: checks[0].status === "pass" ? "pass" : "warn", detail: "Resolution proxy" });
    checks.push({ id: "glare", label: "Glare", status: brightness < 215 ? "pass" : "warn", detail: "Brightness proxy" });
    return checks;
  } catch (err) {
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
  $("#validationResults").innerHTML = result.checks
    .map(
      (check) => `
        <div class="validation-item ${check.status}">
          <span class="dot"></span>
          <span><strong>${check.label}</strong><br>${check.detail}</span>
        </div>
      `,
    )
    .join("");
  $("#submitUploadButton").disabled = false;
}

async function createVerification({ provider, scenario, metadata = {} }) {
  const res = await fetch(`${API_BASE}/v1/verifications`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tenant_id: DEFAULT_TENANT,
      provider,
      scenario,
      customer_reference: `demo-${Date.now()}`,
      checks: provider === "document_upload" ? ["identity", "document"] : ["identity"],
      metadata,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Create failed: ${res.status} ${text}`);
  }

  const created = await res.json();
  return pollVerification(created.verification_id);
}

async function pollVerification(id) {
  let latest = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const res = await fetch(`${API_BASE}/v1/verifications/${id}`);
    latest = await res.json();
    if (["verified", "failed", "requires_review", "expired", "cancelled"].includes(latest.status)) return latest;
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
  renderStep("result");
  refreshClientDashboard();
  refreshOperatorDashboard();
}

function renderLiveTrace(record = state.latestVerification) {
  const root = $("#liveTrace");
  if (!root) return;
  if (!record) {
    root.innerHTML = `
      <div class="trace-strip">
        ${["Customer App", "Reagvis API", "Verification Engine", "Provider Adapter", "Provider", "Normalized Result", "Webhook"].map((label, index) => traceNode(label, index, "created")).join("")}
      </div>
      <div class="trace-footer"><strong>Total --</strong><span>Run a scenario to see this fill with live backend events.</span><span class="pill">READY</span></div>
    `;
    return;
  }

  const labels = traceLabels(record.provider);
  const status = record.status;
  const traceEvents = record.trace_events || [];
  root.innerHTML = `
    <div class="trace-strip">
      ${labels.map((label, index) => traceNode(label, index, index === labels.length - 1 ? "delivery" : status)).join("")}
    </div>
    <div class="trace-footer">
      <strong>${durationLabel(record)}</strong>
      <span>${traceSummary(record)}</span>
      <span class="pill">${status.replaceAll("_", " ").toUpperCase()}</span>
    </div>
    <div class="dashboard-card">
      <h3>State</h3>
      <div class="table">
        ${traceEvents.map((event) => row(event.event, event.state, event.occurred_at?.slice(11, 23) || "")).join("")}
      </div>
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
  return `<div class="trace-node ${className}"><small>${tag}</small><strong>${label}</strong></div>`;
}

function traceSummary(record) {
  if (record.status === "verified") return "Routed through provider, normalized, and delivered to the customer dashboard.";
  if (record.status === "requires_review") return "Routed into the operator queue with audit trail and customer-visible review state.";
  if (record.status === "failed") return `Provider or intake failure captured as ${record.failure_code || "failed"}.`;
  return "Verification is moving through the common lifecycle.";
}

function durationLabel(record) {
  if (!record.completed_at) return "Total --";
  const ms = Date.parse(record.completed_at) - Date.parse(record.created_at);
  return `Total ${(ms / 1000).toFixed(2)}s`;
}

async function refreshClientDashboard() {
  const root = $("#clientDashboard");
  root.innerHTML = `<div class="dashboard-card">Loading dashboard...</div>`;
  try {
    const data = await fetchJson("/v1/dashboard/client");
    root.innerHTML = `
      <div class="kpi-grid">
        ${kpi("Total", data.summary.total)}
        ${kpi("Verified", data.summary.verified)}
        ${kpi("Review", data.summary.requires_review)}
        ${kpi("Failed", data.summary.failed)}
        ${kpi("Processing", data.summary.processing)}
      </div>
      <div class="dashboard-card">
        <h3>Provider health</h3>
        <div class="table">
          ${data.provider_health.map((item) => row(item.label, item.mode === "mock" ? "Sandbox" : item.mode, `${item.volume} sessions`)).join("")}
        </div>
      </div>
      <div class="dashboard-card">
        <h3>Recent verifications</h3>
        <div class="table">${data.recent_verifications.map((item) => row(item.verification_id, item.provider, item.status)).join("")}</div>
      </div>
    `;
  } catch (err) {
    root.innerHTML = `<div class="dashboard-card failed">Could not load client dashboard: ${err.message}</div>`;
  }
}

async function refreshOperatorDashboard() {
  const root = $("#operatorDashboard");
  root.innerHTML = `<div class="dashboard-card">Loading console...</div>`;
  try {
    const data = await fetchJson("/v1/dashboard/operator");
    root.innerHTML = `
      <div class="kpi-grid">
        ${kpi("Review queue", data.queue.length)}
        ${kpi("Audit events", data.audit_events.length)}
        ${kpi("Recent", data.recent_verifications.length)}
      </div>
      <div class="dashboard-card">
        <h3>Manual review queue</h3>
        <div class="table">${data.queue.length ? data.queue.map((item) => row(item.verification_id, item.reason, item.status)).join("") : row("Queue empty", "no holds", "healthy")}</div>
      </div>
      <div class="dashboard-card">
        <h3>Audit trail</h3>
        <div class="table">${data.audit_events.map((item) => row(item.event, item.provider, item.actor)).join("")}</div>
      </div>
    `;
  } catch (err) {
    root.innerHTML = `<div class="dashboard-card failed">Could not load operator dashboard: ${err.message}</div>`;
  }
}

function kpi(label, value) {
  return `<div class="dashboard-card kpi"><small>${label}</small><strong>${value}</strong></div>`;
}

function row(a, b, c) {
  return `<div class="row"><span>${a}</span><small>${b}</small><code>${c}</code></div>`;
}

async function seedDemo() {
  const res = await fetch(`${API_BASE}/v1/demo/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  if (!res.ok) throw new Error(`Seed failed: ${res.status}`);
  const body = await res.json();
  state.latestVerification = body.verifications?.[0] || null;
  renderStep("result");
  setView("operator");
  await refreshClientDashboard();
  await refreshOperatorDashboard();
}

async function resetDemo() {
  const res = await fetch(`${API_BASE}/v1/demo/reset`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Reset failed: ${res.status}`);
  state.latestVerification = null;
  state.upload = null;
  renderStep("start");
  renderLiveTrace(null);
  await refreshClientDashboard();
  await refreshOperatorDashboard();
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

  const refresh = event.target.closest("[data-refresh-dashboard]");
  if (refresh?.dataset.refreshDashboard === "client") refreshClientDashboard();
  if (refresh?.dataset.refreshDashboard === "operator") refreshOperatorDashboard();

  if (event.target.id === "resetFlowButton") {
    state.upload = null;
    state.latestVerification = null;
    renderStep("start");
    renderLiveTrace(null);
  }

  if (event.target.id === "seedDemoButton") {
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

  if (event.target.id === "replayLatestButton") {
    renderLiveTrace(state.latestVerification);
  }

  if (event.target.id === "providerSubmitButton") {
    event.target.disabled = true;
    const scenario = state.provider === "aadhaar_ekyc" ? "success" : "success";
    try {
      await runApplicantScenario(state.provider, scenario, { source: "provider-flow" });
    } finally {
      event.target.disabled = false;
    }
  }

  if (event.target.id === "submitUploadButton" && state.upload) {
    event.target.disabled = true;
    try {
      await runApplicantScenario("document_upload", state.upload.scenario, {
        filename: state.upload.file.name,
        browser_quality_result: state.upload.hardFailed ? "hard_fail" : state.upload.warned ? "warning" : "pass",
      });
    } finally {
      event.target.disabled = false;
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

window.addEventListener("hashchange", () => {
  const view = location.hash.replace("#", "") || "applicant";
  setView(["applicant", "client", "operator"].includes(view) ? view : "applicant");
});

renderStep("start");
setView((location.hash || "#applicant").replace("#", ""));
renderLiveTrace(null);
checkHealth();
refreshClientDashboard();
refreshOperatorDashboard();
