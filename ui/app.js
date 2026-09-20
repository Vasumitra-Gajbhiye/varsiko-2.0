const form = document.getElementById("form");
const repo = document.getElementById("repo");
const go = document.getElementById("go");
const steps = document.getElementById("steps");
const errorEl = document.getElementById("error");
const results = document.getElementById("results");
const specEl = document.getElementById("spec");
const plansEl = document.getElementById("plans");

function setStep(name) {
  steps.hidden = false;
  for (const el of steps.querySelectorAll("[data-step]")) {
    el.classList.toggle("on", el.dataset.step === name);
  }
}

function showError(msg) {
  errorEl.hidden = !msg;
  errorEl.textContent = msg || "";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[c]));
}

function renderSpec(spec) {
  const floor = spec.constraints?.spec_floor || {};
  const cap = spec.capacity || {};
  const decision = spec.decision || {};
  const lockin = spec.lockin_inventory || [];
  specEl.innerHTML = `
    <h2>Required server</h2>
    <dl>
      <dt>Project</dt><dd>${esc(spec.source_project)}</dd>
      <dt>Verdict</dt><dd>${esc(decision.verdict || "—")}</dd>
      <dt>vCPU</dt><dd>${esc(floor.vcpu ?? cap.vcpu)}</dd>
      <dt>RAM</dt><dd>${esc(floor.ram_gb ?? cap.ram_gb)} GB</dd>
      <dt>Disk</dt><dd>${esc(floor.disk_gb ?? cap.disk_gb)} GB</dd>
      <dt>Egress</dt><dd>${esc(floor.egress_tb ?? cap.egress_tb)} TB</dd>
      <dt>Ceiling</dt><dd>₹${esc(spec.constraints?.ceiling_inr_monthly)}</dd>
    </dl>
    <p class="meta empty" style="margin-top:12px">
      Lock-in: ${lockin.length ? lockin.map((i) => esc(i.feature)).join(", ") : "none flagged"}
    </p>
  `;
}

function renderPlans(plans, extra) {
  if (!plans.length) {
    plansEl.innerHTML = `<h2>Suggested VPS</h2><p class="empty">No plan passed the floor and ceiling.</p>`;
    return;
  }
  const cards = plans.map((p, i) => {
    const url = p.source_url || "";
    const link = url ? `<a href="${esc(url)}" target="_blank" rel="noreferrer">Open pricing</a>` : "";
    return `
      <div class="plan ${i === 0 ? "winner" : ""}">
        <strong>${esc(p.provider)} · ${esc(p.plan_sku)}</strong>
        <div class="meta">₹${esc(p.monthly_inr)} / mo${p.region ? " · " + esc(p.region) : ""}</div>
        ${link}
      </div>`;
  }).join("");
  const session = extra?.nasiko_session_url
    ? `<p class="empty"><a href="${esc(extra.nasiko_session_url)}" target="_blank" rel="noreferrer">Open Nasiko session</a></p>`
    : "";
  plansEl.innerHTML = `<h2>Suggested VPS</h2>${cards}${session}`;
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  showError("");
  results.hidden = true;
  go.disabled = true;
  setStep("surveyor");
  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: repo.value.trim() }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.statusText);
    setStep("broker");
    renderSpec(body.spec || {});
    renderPlans(body.plans || [], body);
    results.hidden = false;
  } catch (err) {
    showError(err.message || String(err));
  } finally {
    go.disabled = false;
  }
});
