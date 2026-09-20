const form = document.getElementById("form");
const repo = document.getElementById("repo");
const go = document.getElementById("go");
const errorEl = document.getElementById("error");
const ops = document.getElementById("ops");
const rail = document.getElementById("rail");
const logEl = document.getElementById("log");
const logMeta = document.getElementById("logmeta");
const specEl = document.getElementById("spec");
const plansEl = document.getElementById("plans");
const porterEl = document.getElementById("porter");
const pilotEl = document.getElementById("pilot");
const stampEl = document.getElementById("pilot-stamp");

const AGENTS = ["surveyor", "porter", "broker", "pilot"];
const SURVEYOR_STAGES = [
  "resolving project",
  "pulling billing",
  "querying metrics",
  "walking repo",
  "deriving spec",
];
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const PACE = {
  log: 850,
  phase: 1600,
  artifact: 2000,
  error: 0,
  done: 1400,
};

const verbs = {
  idle: "idle",
  running: "live",
  done: "done",
  skipped: "skipped",
  error: "fault",
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[c]));
}

function showError(msg) {
  errorEl.hidden = !msg;
  errorEl.textContent = msg || "";
}

function resetFloor() {
  logEl.innerHTML = "";
  specEl.innerHTML = "";
  plansEl.innerHTML = "";
  porterEl.innerHTML = "";
  pilotEl.innerHTML = "";
  stampEl.hidden = true;
  logMeta.textContent = "streaming";
  for (const agent of AGENTS) {
    setPhase(agent, "idle");
    const list = document.getElementById(`stages-${agent}`);
    if (!list) continue;
    for (const li of list.querySelectorAll("li")) {
      li.classList.remove("on", "ok", "skip");
    }
  }
}

function setPhase(agent, status) {
  const node = rail.querySelector(`.node[data-agent="${agent}"]`);
  const consoleEl = document.getElementById(`console-${agent}`);
  const pipe = rail.querySelector(`.pipe[data-from="${agent}"]`);
  for (const el of [node, consoleEl]) {
    if (!el) continue;
    el.classList.remove("idle", "running", "done", "skipped", "error");
    el.classList.add(status);
  }
  for (const verb of document.querySelectorAll(`[data-verb="${agent}"]`)) {
    verb.textContent = verbs[status] || status;
  }
  if (pipe) pipe.classList.toggle("flow", status === "running" && !reduceMotion);
}

function clock(ts) {
  const d = ts ? new Date(ts * 1000) : new Date();
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return d.toISOString().slice(11, 19);
}

function appendLog(agent, text, ts, isErr) {
  if (!text) return;
  const clipped = String(text).split("\n")[0].slice(0, 180);
  const row = document.createElement("div");
  row.className = "row" + (isErr ? " err" : "");
  row.innerHTML = `<span class="ts">${esc(clock(ts))}</span><span class="who">${esc(agent)}</span><span class="txt">${esc(clipped)}</span>`;
  logEl.appendChild(row);
  while (logEl.children.length > 400) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
  logMeta.textContent = `${agent} · ${clipped.slice(0, 48)}`;
  markFromLog(agent, clipped);
}

function markItem(listId, key, cls) {
  const li = document.querySelector(`#${listId} [data-key="${key}"]`);
  if (!li) return;
  li.classList.remove("on", "ok", "skip");
  li.classList.add(cls);
}

function markFromLog(agent, text) {
  const lower = text.toLowerCase();
  if (agent === "surveyor") {
    for (const stage of SURVEYOR_STAGES) {
      if (lower.includes(stage)) {
        const list = document.getElementById("stages-surveyor");
        for (const li of list.querySelectorAll("li.on")) {
          li.classList.remove("on");
          li.classList.add("ok");
        }
        markItem("stages-surveyor", stage, "on");
      }
    }
  }
  if (agent === "broker") {
    for (const provider of ["hetzner", "digitalocean", "vultr"]) {
      if (!lower.includes(provider)) continue;
      if (lower.includes("unreachable")) markItem("stages-broker", provider, "skip");
      else if (lower.includes("quoted") || lower.includes("scored")) markItem("stages-broker", provider, "ok");
      else markItem("stages-broker", provider, "on");
    }
    if (lower.includes("scoring")) {
      for (const li of document.querySelectorAll("#stages-broker li.on")) {
        li.classList.remove("on");
        li.classList.add("ok");
      }
    }
  }
  if (agent === "porter" && (lower.includes("dry-run") || lower.includes("rewrite"))) {
    const items = [...document.querySelectorAll("#stages-porter li")];
    items.forEach((li, i) => {
      const apply = () => {
        if (!li.classList.contains("ok")) li.classList.add("on");
      };
      if (reduceMotion) apply();
      else setTimeout(apply, i * 280);
    });
  }
  if (agent === "pilot") {
    if (lower.includes("verify")) markItem("stages-pilot", "verify mandate", "on");
    if (lower.includes("park")) {
      markItem("stages-pilot", "verify mandate", "ok");
      markItem("stages-pilot", "route lane", "ok");
      markItem("stages-pilot", "park", "on");
    }
  }
}

function finishChecklist(listId, ok) {
  const items = [...document.querySelectorAll(`#${listId} li`)];
  items.forEach((li, i) => {
    const apply = () => {
      li.classList.remove("on");
      if (ok) li.classList.add("ok");
      else if (!li.classList.contains("ok")) li.classList.add("skip");
    };
    if (reduceMotion) apply();
    else setTimeout(apply, i * 240);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayFor(ev) {
  if (reduceMotion) return 0;
  if (!ev || typeof ev !== "object") return PACE.log;
  if (ev.type === "phase" && ev.status === "running") return 2200;
  return PACE[ev.type] ?? PACE.log;
}

function tickText(el, prefix, value, suffix) {
  if (value == null || value === "" || reduceMotion) {
    el.textContent = `${prefix}${value ?? "—"}${suffix}`;
    return;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    el.textContent = `${prefix}${value}${suffix}`;
    return;
  }
  const start = performance.now();
  const from = 0;
  const dur = 1600;
  function frame(now) {
    const p = Math.min(1, (now - start) / dur);
    el.textContent = `${prefix}${Math.round(from + (num - from) * p)}${suffix}`;
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function renderSpec(spec) {
  const floor = spec.constraints?.spec_floor || {};
  const cap = spec.capacity || {};
  const decision = spec.decision || {};
  specEl.innerHTML = `
    <h2>Capacity</h2>
    <dl>
      <dt>Project</dt><dd>${esc(spec.source_project || "—")}</dd>
      <dt>Verdict</dt><dd>${esc(decision.verdict || "—")}</dd>
      <dt>vCPU</dt><dd data-tick="vcpu"></dd>
      <dt>RAM</dt><dd data-tick="ram"></dd>
      <dt>Disk</dt><dd data-tick="disk"></dd>
      <dt>Ceiling</dt><dd data-tick="ceil"></dd>
    </dl>
  `;
  tickText(specEl.querySelector("[data-tick=vcpu]"), "", floor.vcpu ?? cap.vcpu ?? "—", "");
  tickText(specEl.querySelector("[data-tick=ram]"), "", floor.ram_gb ?? cap.ram_gb ?? "—", " GB");
  tickText(specEl.querySelector("[data-tick=disk]"), "", floor.disk_gb ?? cap.disk_gb ?? "—", " GB");
  tickText(specEl.querySelector("[data-tick=ceil]"), "₹", spec.constraints?.ceiling_inr_monthly ?? "—", "");
  finishChecklist("stages-surveyor", true);
}

function renderPlans(plans, extra) {
  if (!plans || !plans.length) {
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
  finishChecklist("stages-broker", true);
}

function plansFromShop(shop, mandate) {
  const plans = [];
  const seen = new Set();
  const add = (item) => {
    if (!item || typeof item !== "object") return;
    const key = `${item.provider || ""}:${item.plan_sku || ""}`;
    if (!item.provider || seen.has(key)) return;
    seen.add(key);
    plans.push(item);
  };
  if (shop) {
    add(shop.winner);
    add(shop.runner_up);
    for (const item of shop.survivors || []) add(item);
  }
  if (!plans.length && mandate) {
    add(mandate.decision);
    add(mandate.runner_up);
  }
  return plans;
}

function renderPorter(port, diff) {
  if (!port && !diff) {
    porterEl.innerHTML = "";
    return;
  }
  const steps = port?.steps ?? port?.plan?.steps?.length ?? "—";
  const unhandled = port?.unhandled ?? port?.plan?.unhandled?.length ?? "—";
  const status = port?.status || "planned";
  const note = port?.note || "Dry-run only. Diff is a reviewable handoff; nothing was pushed.";
  const diffPreview = diff
    ? `<pre>${esc(String(diff).slice(0, 4000))}${String(diff).length > 4000 ? "\n…" : ""}</pre>`
    : `<p class="empty">No diff (noop or skipped).</p>`;
  porterEl.innerHTML = `
    <h2>Rewrite</h2>
    <dl class="spec">
      <dt>Status</dt><dd>${esc(status)}</dd>
      <dt>Steps</dt><dd>${esc(steps)}</dd>
      <dt>Human</dt><dd>${esc(unhandled)}</dd>
    </dl>
    <p class="empty" style="margin:8px 0 0">${esc(note)}</p>
    ${diffPreview}
  `;
  const kinds = new Set();
  const planSteps = port?.plan?.steps || [];
  for (const step of planSteps) {
    const kind = (step.kind || step.id || "").toLowerCase();
    for (const key of ["kv", "blob", "image", "isr", "cron", "middleware", "platform", "deploy"]) {
      if (kind.includes(key)) kinds.add(key);
    }
  }
  for (const li of document.querySelectorAll("#stages-porter li")) {
    li.classList.remove("on");
    if (!kinds.size || kinds.has(li.dataset.key)) li.classList.add("ok");
    else li.classList.add("skip");
  }
}

function renderPilot(pilot) {
  if (!pilot) {
    pilotEl.innerHTML = "";
    return;
  }
  const data = pilot.data || pilot;
  const status = data.status || data.state || "parked";
  const lane = data.lane || "—";
  const reason = data.reason || data.next_owner || "";
  const mandateId = data.mandate_id || "—";
  stampEl.hidden = false;
  pilotEl.innerHTML = `
    <h2>Mandate</h2>
    <dl class="spec">
      <dt>Status</dt><dd>${esc(status)}</dd>
      <dt>Lane</dt><dd>${esc(lane)}</dd>
      <dt>Id</dt><dd>${esc(mandateId)}</dd>
    </dl>
    <p class="empty" style="margin-top:8px">${esc(reason || "Parked. No purchase in the demo path.")}</p>
  `;
  finishChecklist("stages-pilot", true);
}

function applyResult(body) {
  if (body.spec) renderSpec(body.spec);
  renderPorter(body.port, body.porter_diff);
  renderPlans(body.plans || [], body);
  if (body.pilot) renderPilot(body.pilot);
}

async function playFallback(body) {
  const porterDone = Boolean(body.port || body.porter_diff);
  const brokerDone = Boolean((body.plans || []).length || body.shop);
  const pilotDone = Boolean(body.pilot);
  const beat = async (fn) => {
    fn();
    if (!reduceMotion) await sleep(1600);
  };
  await beat(() => setPhase("surveyor", "running"));
  await beat(() => {
    setPhase("surveyor", "done");
    if (body.spec) renderSpec(body.spec);
  });
  if (porterDone) {
    await beat(() => setPhase("porter", "running"));
    await beat(() => {
      setPhase("porter", "done");
      renderPorter(body.port, body.porter_diff);
    });
  } else {
    await beat(() => setPhase("porter", "skipped"));
  }
  if (brokerDone) {
    await beat(() => setPhase("broker", "running"));
    await beat(() => {
      setPhase("broker", "done");
      renderPlans(body.plans || [], body);
    });
  } else {
    await beat(() => setPhase("broker", "skipped"));
  }
  if (pilotDone) {
    await beat(() => setPhase("pilot", "running"));
    await beat(() => {
      setPhase("pilot", "done");
      renderPilot(body.pilot);
    });
  } else {
    await beat(() => setPhase("pilot", "skipped"));
  }
  applyResult(body);
  logMeta.textContent = "complete";
}

function handleEvent(ev, state) {
  if (!ev || typeof ev !== "object") return;
  if (ev.type === "phase") {
    setPhase(ev.agent, ev.status);
    if (ev.status === "skipped") finishChecklist(`stages-${ev.agent}`, false);
    return;
  }
  if (ev.type === "log") {
    appendLog(ev.agent || "sys", ev.text || "", ev.ts, false);
    return;
  }
  if (ev.type === "artifact") {
    const kind = ev.kind;
    const data = ev.data;
    if (kind === "spec") {
      state.spec = data;
      renderSpec(data);
    } else if (kind === "port") {
      state.port = data;
      renderPorter(state.port, state.diff);
    } else if (kind === "diff") {
      state.diff = data;
      renderPorter(state.port, state.diff);
    } else if (kind === "shop") {
      state.shop = data;
      renderPlans(plansFromShop(state.shop, state.mandate), state);
    } else if (kind === "mandate") {
      state.mandate = data;
      renderPlans(plansFromShop(state.shop, state.mandate), state);
    } else if (kind === "pilot") {
      state.pilot = data;
      renderPilot(data);
    }
    appendLog(ev.agent || "sys", `artifact ${kind}`, ev.ts, false);
    return;
  }
  if (ev.type === "error") {
    showError(ev.error || "pipeline failed");
    appendLog("sys", ev.error || "pipeline failed", ev.ts, true);
    return;
  }
  if (ev.type === "done") {
    state.done = ev;
    applyResult(ev);
    logMeta.textContent = "complete";
  }
}

async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    buf = buf.replace(/\r\n/g, "\n");
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          if (onEvent(JSON.parse(payload))) {
            try { await reader.cancel(); } catch { /* already closed */ }
            return;
          }
        } catch {
          /* ignore malformed frames */
        }
      }
    }
  }
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  showError("");
  go.disabled = true;
  document.body.classList.add("live");
  ops.hidden = false;
  resetFloor();
  setPhase("surveyor", "running");
  appendLog("sys", `dispatch ${repo.value.trim()}`, Date.now() / 1000, false);
  const payload = JSON.stringify({ repo: repo.value.trim() });
  const state = {};
  try {
    const res = await fetch("/api/run/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: payload,
    });
    const ctype = res.headers.get("content-type") || "";
    if (res.status === 404 || !ctype.includes("text/event-stream")) {
      if (!res.ok && res.status !== 404) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || res.statusText);
      }
      appendLog("sys", "stream unavailable · falling back", Date.now() / 1000, false);
      const fallback = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      const body = await fallback.json();
      if (!fallback.ok) throw new Error(body.error || fallback.statusText);
      await playFallback(body);
      return;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || res.statusText);
    }
    let playChain = Promise.resolve();
    await readSSE(res, (frame) => {
      playChain = playChain.then(async () => {
        handleEvent(frame, state);
        const ms = delayFor(frame);
        if (ms) await sleep(ms);
      });
      return frame.type === "done" || frame.type === "error";
    });
    await playChain;
    if (!state.done && !errorEl.textContent) {
      throw new Error("stream ended before the pipeline finished");
    }
  } catch (err) {
    showError(err.message || String(err));
    appendLog("sys", err.message || String(err), Date.now() / 1000, true);
  } finally {
    go.disabled = false;
  }
});
