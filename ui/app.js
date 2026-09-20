/* Severance demo UI.
 *
 * Events are rendered as they arrive. There is no artificial pacing: the pauses you
 * see on screen are the agents actually working on Nasiko.
 */

const $ = (id) => document.getElementById(id);

const els = {
  form: $("form"), repo: $("repo"), ceiling: $("ceiling"), go: $("go"), error: $("error"),
  stepRepo: $("step-repo"), stepPipeline: $("step-pipeline"), stepChoose: $("step-choose"),
  stepReceipt: $("step-receipt"),
  rail: $("rail"), log: $("log"), logmeta: $("logmeta"),
  specCard: $("spec-card"), specStats: $("spec-stats"), lockin: $("lockin"),
  porterCard: $("porter-card"), porterStats: $("porter-stats"),
  diffWrap: $("diff-wrap"), porterDiff: $("porter-diff"),
  controlCard: $("control-card"), controlRows: $("control-rows"),
  plans: $("plans"), chooseSub: $("choose-sub"),
  anakinStrip: $("anakin-strip"), anakinMode: $("anakin-mode"),
  anakinRows: $("anakin-rows"),
  refused: $("refused"), refusedRows: $("refused-rows"),
  authorize: $("authorize"), authPlan: $("auth-plan"), authSub: $("auth-sub"),
  authGo: $("auth-go"), authError: $("auth-error"), authFine: $("auth-fine"),
  receiptStamp: $("receipt-stamp"), receiptTitle: $("receipt-title"),
  receiptSub: $("receipt-sub"), receiptGrid: $("receipt-grid"),
  receiptNext: $("receipt-next"), receiptLinks: $("receipt-links"),
  restart: $("restart"), footLinks: $("foot-links"),
  hero: $("hero"), rundown: $("rundown"), repoSummary: $("repo-summary"),
  summaryRepo: $("summary-repo"), summaryBudget: $("summary-budget"),
  summaryEdit: $("summary-edit"),
  nasikoPill: $("nasiko-pill"), nasikoDot: $("nasiko-dot"), nasikoLabel: $("nasiko-label"),
};

const PROVIDER_LABEL = {
  hetzner: "Hetzner", digitalocean: "DigitalOcean", vultr: "Vultr",
};

const VERB = {
  idle: "waiting", running: "working", done: "done",
  skipped: "skipped", error: "failed",
};

const state = {
  runId: null,
  choices: [],
  selected: null,
  nasiko: null,
  survey: null,
};

/* ── helpers ─────────────────────────────────────────────── */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function inr(n) {
  if (n == null || n === "") return "—";
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  return "₹" + num.toLocaleString("en-IN");
}

function num(n, unit) {
  if (n == null || n === "") return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  const shown = Number.isInteger(v) ? v : Math.round(v * 10) / 10;
  return unit ? `${shown}<small>${unit}</small>` : String(shown);
}

function clock(ts) {
  const d = ts ? new Date(ts * 1000) : new Date();
  return Number.isNaN(d.getTime()) ? "--:--:--" : d.toTimeString().slice(0, 8);
}

function show(el, on = true) { if (el) el.hidden = !on; }

/* The form has done its job once a survey lands; collapse it so the choice leads. */
function collapseForm(on) {
  show(els.hero, !on);
  show(els.form, !on);
  show(els.rundown, !on);
  show(els.repoSummary, on);
  if (on) {
    els.summaryRepo.textContent = els.repo.value.trim().replace(/^https?:\/\//, "");
    els.summaryBudget.textContent = `ceiling ${inr(Number(els.ceiling.value))} / month`;
  }
}

function showError(el, msg) {
  if (!el) return;
  el.hidden = !msg;
  el.textContent = msg || "";
}

/* ── pipeline rail + log ─────────────────────────────────── */

function setPhase(agent, status) {
  const node = els.rail.querySelector(`.node[data-agent="${agent}"]`);
  if (node) {
    node.classList.remove("idle", "running", "done", "skipped", "error");
    node.classList.add(status);
  }
  const verb = document.querySelector(`[data-verb="${agent}"]`);
  if (verb) verb.textContent = VERB[status] || status;
}

function appendLog(agent, text, ts, isErr) {
  if (!text) return;
  const line = String(text).split("\n")[0].slice(0, 200);
  const row = document.createElement("div");
  row.className = "row" + (isErr ? " err" : "");
  row.innerHTML =
    `<span class="ts">${esc(clock(ts))}</span>` +
    `<span class="who">${esc(agent || "sys")}</span>` +
    `<span class="txt">${esc(line)}</span>`;
  els.log.appendChild(row);
  while (els.log.children.length > 500) els.log.removeChild(els.log.firstChild);
  els.log.scrollTop = els.log.scrollHeight;
  els.logmeta.textContent = line.slice(0, 64);
}

function resetPipeline() {
  els.log.innerHTML = "";
  els.logmeta.textContent = "starting";
  els.specStats.innerHTML = "";
  els.lockin.innerHTML = "";
  els.porterStats.innerHTML = "";
  els.porterDiff.textContent = "";
  els.plans.innerHTML = "";
  els.refusedRows.innerHTML = "";
  show(els.specCard, false);
  show(els.porterCard, false);
  show(els.diffWrap, false);
  show(els.refused, false);
  show(els.anakinStrip, false);
  show(els.authorize, false);
  show(els.authFine, false);
  show(els.stepChoose, false);
  show(els.stepReceipt, false);
  showError(els.authError, "");
  state.selected = null;
  for (const a of ["surveyor", "porter", "broker", "pilot"]) setPhase(a, "idle");
}

/* ── control plane ───────────────────────────────────────── */

function renderControl(nasiko) {
  if (!nasiko) return;
  state.nasiko = nasiko;
  const ids = nasiko.agent_ids || {};
  const rows = ["surveyor", "porter", "broker", "pilot"].map((name) => {
    const id = ids[name];
    if (!id) return "";
    const href = nasiko[name];
    const label = href
      ? `<a class="cid" href="${esc(href)}" target="_blank" rel="noreferrer">${esc(id)}</a>`
      : `<span class="cid">${esc(id)}</span>`;
    return `<div class="crow"><span class="cname">${esc(name)}</span>${label}</div>`;
  }).join("");
  els.controlRows.innerHTML = rows;
  show(els.controlCard, Boolean(rows));

  const links = [];
  if (nasiko.base) links.push(`<a href="${esc(nasiko.base)}" target="_blank" rel="noreferrer">Dashboard</a>`);
  if (nasiko.sessions) links.push(`<a href="${esc(nasiko.sessions)}" target="_blank" rel="noreferrer">Sessions</a>`);
  if (nasiko.workflows) links.push(`<a href="${esc(nasiko.workflows)}" target="_blank" rel="noreferrer">severance-pipeline</a>`);
  els.footLinks.innerHTML = links.join("");
}

async function pollNasiko() {
  try {
    const res = await fetch("/api/nasiko");
    const body = await res.json();
    const n = (body.agents || []).length;
    els.nasikoPill.href = body.links?.dashboard || body.url || "#";
    if (body.links && !els.footLinks.innerHTML) {
      els.footLinks.innerHTML = [
        ["Dashboard", body.links.dashboard],
        ["Agents", body.links.agents],
        ["Sessions", body.links.sessions],
        ["severance-pipeline", body.links.workflows],
      ].filter(([, href]) => href)
        .map(([label, href]) => `<a href="${esc(href)}" target="_blank" rel="noreferrer">${esc(label)}</a>`)
        .join("");
    }
    if (body.reachable) {
      els.nasikoPill.className = "pill ok";
      els.nasikoLabel.textContent = `Nasiko · ${n} agent${n === 1 ? "" : "s"}`;
    } else {
      els.nasikoPill.className = "pill bad";
      els.nasikoLabel.textContent = "Nasiko unreachable";
    }
  } catch {
    els.nasikoPill.className = "pill bad";
    els.nasikoLabel.textContent = "Nasiko unreachable";
  }
}

/* ── renderers ───────────────────────────────────────────── */

function renderSpec(spec) {
  if (!spec) return;
  const floor = spec.constraints?.spec_floor || {};
  const cap = spec.capacity || {};
  const cells = [
    ["vCPU", num(floor.vcpu ?? cap.vcpu)],
    ["Memory", num(floor.ram_gb ?? cap.ram_gb, " GB")],
    ["Disk", num(floor.disk_gb ?? cap.disk_gb, " GB")],
    ["Egress", num(floor.egress_tb ?? cap.egress_tb, " TB")],
    ["Ceiling", inr(spec.constraints?.ceiling_inr_monthly)],
  ];
  const current = spec.current_cost?.monthly_inr;
  if (current) cells.push(["Vercel today", inr(current)]);
  els.specStats.innerHTML = cells
    .map(([k, v]) => `<div class="stat"><span>${esc(k)}</span><b>${v}</b></div>`)
    .join("");

  const lock = spec.lockin_inventory || [];
  els.lockin.innerHTML = lock.length
    ? lock.map((f) => {
        const name = typeof f === "string" ? f : f.feature;
        const breaks = typeof f === "object" && f.breaks_on_selfhost;
        return `<span class="tag${breaks ? " warn" : ""}">${esc(name)}</span>`;
      }).join("")
    : "";
  show(els.specCard, true);
}

function renderPorter(port, diff) {
  if (!port && !diff) return;
  const steps = port?.steps ?? port?.plan?.steps?.length ?? "—";
  const unhandled = port?.unhandled ?? port?.plan?.unhandled?.length ?? "—";
  els.porterStats.innerHTML = [
    ["Status", esc(port?.status || "planned")],
    ["Automated", num(steps)],
    ["Needs a human", num(unhandled)],
  ].map(([k, v]) => `<div class="stat"><span>${esc(k)}</span><b>${v}</b></div>`).join("");
  if (diff) {
    els.porterDiff.textContent = String(diff).slice(0, 8000);
    show(els.diffWrap, true);
  }
  show(els.porterCard, true);
}

function planCard(c, index) {
  const live = c.discovered_via === "anakin-search";
  const viaLabel = live ? "anakin · live" : esc(c.discovered_via || "unknown");
  const specs = [
    c.vcpu ? `${Number(c.vcpu)} vCPU` : null,
    c.ram_gb ? `${Number(c.ram_gb)} GB RAM` : null,
    c.disk_gb ? `${Number(c.disk_gb)} GB disk` : null,
    c.egress_tb ? `${Number(c.egress_tb)} TB egress` : null,
    c.region || null,
  ].filter(Boolean).map((s) => `<span>${esc(s)}</span>`).join("");

  const listed = c.listed_amount != null
    ? `${esc(c.listed_currency)} ${esc(c.listed_amount)} listed · FX pinned ${esc((c.fx_pinned_at || "").slice(0, 10))}`
    : "";

  return `
    <button type="button" class="plan" data-index="${index}"
            aria-pressed="false">
      ${c.recommended ? '<span class="ribbon">Best value</span>' : ""}
      <div class="vendor">${esc(c.provider_label)}</div>
      <div class="sku">${esc(c.plan_sku)}</div>
      <div class="price">${inr(c.monthly_inr)}<small> / mo</small></div>
      <div class="listed">${listed}</div>
      <div class="specs">${specs}</div>
      <div class="prov">
        <span class="src${live ? "" : " fallback"}">${viaLabel}</span>
        ${c.source_url ? `<a class="link" href="${esc(c.source_url)}" target="_blank" rel="noreferrer">pricing page</a>` : ""}
      </div>
    </button>`;
}

function selectPlan(index) {
  const c = state.choices[index];
  if (!c) return;
  state.selected = c;
  for (const el of els.plans.querySelectorAll(".plan")) {
    const on = Number(el.dataset.index) === index;
    el.classList.toggle("sel", on);
    el.setAttribute("aria-pressed", String(on));
  }
  els.authPlan.textContent = `${c.provider_label} ${c.plan_sku}`;
  els.authSub.textContent =
    `${inr(c.monthly_inr)} per month${c.region ? " · " + c.region : ""}`;
  els.authGo.textContent = `Authorise ${inr(c.monthly_inr)}/mo`;
  show(els.authorize, true);
  show(els.authFine, true);
}

function renderChoices(body) {
  state.choices = body.choices || [];
  const refused = body.rejected || [];
  const anakin = body.anakin || {};

  const live = anakin.mode === "live";
  const sourced = live
    ? "Prices were read from the vendors' own pricing pages through Anakin."
    : "Anakin was unreachable or offline, so these came from pinned fixtures — labelled on each card.";
  els.chooseSub.innerHTML =
    `${state.choices.length} of ${state.choices.length + refused.length} plans cleared your ` +
    `${inr(body.ceiling)} ceiling. ${esc(sourced)}`;

  const providers = anakin.providers || {};
  const names = Object.keys(providers);
  if (names.length) {
    els.anakinMode.textContent = live
      ? `${anakin.live} of ${names.length} vendors priced from a live scrape`
      : "no live scrape on this run — prices are pinned fixtures";
    els.anakinRows.innerHTML = names.map((id) => {
      const via = providers[id];
      const isLive = via === "anakin-search";
      const label = PROVIDER_LABEL[id] || id;
      return `<span class="achip${isLive ? " live" : ""}">` +
             `<span class="adot"></span>${esc(label)} <code>${esc(via)}</code></span>`;
    }).join("");
    show(els.anakinStrip, true);
  }

  if (!state.choices.length) {
    els.plans.innerHTML =
      `<div class="card pad"><h2>No plan qualified</h2>` +
      `<p class="hint">Every candidate was refused. Raise the budget or relax the region ` +
      `allowlist and survey again.</p></div>`;
  } else {
    els.plans.innerHTML = state.choices.map(planCard).join("");
    for (const el of els.plans.querySelectorAll(".plan")) {
      el.addEventListener("click", () => selectPlan(Number(el.dataset.index)));
    }
  }

  if (refused.length) {
    els.refusedRows.innerHTML = refused.map((r) => `
      <div class="rrow">
        <b>${esc(r.provider_label)} ${esc(r.plan_sku)}</b>
        <span class="why">${esc(r.reason_text)}</span>
        <span class="detail">${esc(r.detail || "")}</span>
      </div>`).join("");
    show(els.refused, true);
  }

  show(els.stepChoose, true);
  if (state.choices.length) selectPlan(0);
  els.stepChoose.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderReceipt(body) {
  const m = body.mandate || {};
  const pilot = body.pilot || {};
  const d = m.decision || {};
  const ca = m.constraints_applied || {};
  const parked = String(pilot.status || "").toUpperCase();
  const refused = parked === "REFUSED";

  els.receiptStamp.textContent = parked || "AUTHORISED";
  els.receiptStamp.className = "stamp" + (refused ? " refused" : "");
  els.receiptTitle.textContent = refused
    ? "The Pilot refused this mandate"
    : `${body.chosen?.provider_label || d.provider} ${d.plan_sku} authorised`;
  els.receiptSub.textContent = refused
    ? (pilot.reason || "The mandate did not verify.")
    : "The Broker signed it, you approved it, and the Pilot verified the signature and parked.";

  const rows = [
    ["Mandate", m.mandate_id, true],
    ["Approved by", m.approval?.approver],
    ["Approved at", (m.approval?.approved_at || "").replace("T", " ").replace("Z", " UTC")],
    ["Expires", (m.expires_at || "").replace("T", " ").replace("Z", " UTC")],
    ["Monthly", inr(d.monthly_inr)],
    ["Headroom left", inr(ca.headroom_inr)],
    ["Signature", m.signature ? `${m.signature.alg} ${String(m.signature.value).slice(0, 16)}…` : null, true],
    ["Committed spend", `$${pilot.cost_committed_usd ?? 0}`],
    ["Lane", pilot.lane],
    ["Run", pilot.run_id, true],
  ].filter(([, v]) => v != null && v !== "");

  els.receiptGrid.innerHTML = rows.map(([k, v, mono]) =>
    `<div><dt>${esc(k)}</dt><dd${mono ? ' class="mono"' : ""}>${esc(v)}</dd></div>`
  ).join("");

  els.receiptNext.textContent = pilot.next_owner
    ? `Next: ${pilot.next_owner}`
    : "Nothing was purchased and no card was charged.";

  const n = body.nasiko || state.nasiko || {};
  const links = [];
  for (const name of ["broker", "pilot"]) {
    if (n[name]) links.push(`<a href="${esc(n[name])}" target="_blank" rel="noreferrer">${name} session on Nasiko</a>`);
  }
  if (n.sessions) links.push(`<a href="${esc(n.sessions)}" target="_blank" rel="noreferrer">All sessions</a>`);
  els.receiptLinks.innerHTML = links.join("");

  show(els.stepReceipt, true);
  els.stepReceipt.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ── SSE ─────────────────────────────────────────────────── */

async function streamPost(url, payload, onEvent) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(payload),
  });
  if (!res.ok && !(res.headers.get("content-type") || "").includes("text/event-stream")) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || res.statusText);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let done = null;
  while (true) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        let ev;
        try { ev = JSON.parse(raw); } catch { continue; }
        if (ev.type === "error") throw new Error(ev.error || "the run failed");
        if (ev.type === "done") done = ev;
        onEvent(ev);
      }
    }
  }
  if (!done) throw new Error("the stream ended before the run finished");
  return done;
}

function handleEvent(ev) {
  switch (ev.type) {
    case "phase":
      setPhase(ev.agent, ev.status);
      break;
    case "log":
      appendLog(ev.agent, ev.text, ev.ts, false);
      break;
    case "session":
      appendLog(ev.agent, `nasiko session ${ev.session_id}`, ev.ts, false);
      break;
    case "control":
      appendLog("sys", `control plane: ${Object.keys(ev.agent_ids || {}).length} agents`, ev.ts, false);
      break;
    case "artifact":
      if (ev.kind === "spec") renderSpec(ev.data);
      else if (ev.kind === "port") renderPorter(ev.data, null);
      else if (ev.kind === "diff") renderPorter(null, ev.data);
      appendLog(ev.agent, `artifact · ${ev.kind}`, ev.ts, false);
      break;
    default:
      break;
  }
}

/* ── flows ───────────────────────────────────────────────── */

els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  showError(els.error, "");
  els.go.disabled = true;
  els.go.textContent = "Surveying…";
  show(els.stepPipeline, true);
  resetPipeline();
  setPhase("surveyor", "running");
  els.stepPipeline.scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    const body = await streamPost("/api/survey/stream", {
      repo: els.repo.value.trim(),
      ceiling: Number(els.ceiling.value) || undefined,
    }, handleEvent);

    state.runId = body.run_id;
    state.survey = body;
    collapseForm(true);
    renderControl(body.nasiko);
    renderSpec(body.spec);
    renderPorter(body.port, body.porter_diff);
    els.logmeta.textContent = "survey complete";

    if (body.blocked) {
      showError(els.error, `The Surveyor returned ${body.verdict}. Nothing was shopped.`);
      return;
    }
    renderChoices(body);
  } catch (err) {
    showError(els.error, err.message || String(err));
    appendLog("sys", err.message || String(err), null, true);
  } finally {
    els.go.disabled = false;
    els.go.textContent = "Survey repository";
  }
});

els.authGo.addEventListener("click", async () => {
  if (!state.selected || !state.runId) return;
  showError(els.authError, "");
  els.authGo.disabled = true;
  els.authGo.textContent = "Authorising…";
  setPhase("broker", "running");

  try {
    const body = await streamPost("/api/authorize/stream", {
      run_id: state.runId,
      provider: state.selected.provider,
      plan_sku: state.selected.plan_sku,
    }, handleEvent);
    renderControl(body.nasiko);
    renderReceipt(body);
    els.logmeta.textContent = "authorised";
    show(els.authorize, false);
  } catch (err) {
    showError(els.authError, err.message || String(err));
    appendLog("sys", err.message || String(err), null, true);
  } finally {
    els.authGo.disabled = false;
    if (state.selected) els.authGo.textContent = `Authorise ${inr(state.selected.monthly_inr)}/mo`;
  }
});

els.summaryEdit.addEventListener("click", () => {
  collapseForm(false);
  els.repo.focus();
});

els.restart.addEventListener("click", () => {
  state.runId = null;
  state.selected = null;
  collapseForm(false);
  show(els.stepReceipt, false);
  show(els.stepChoose, false);
  show(els.stepPipeline, false);
  resetPipeline();
  els.stepRepo.scrollIntoView({ behavior: "smooth", block: "start" });
  els.repo.focus();
});

pollNasiko();
setInterval(pollNasiko, 15000);
