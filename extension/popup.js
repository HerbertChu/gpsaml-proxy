// Popup view-state machine. Walks the user through Portal → Gateway →
// Progress → Connected, mirroring gpsaml's window flow but inside a
// single popup. The heavy work (SAML capture, PAN protocol, bastion
// call, .command download) lives in background.js — popup just sends
// intents and reflects state.

import { DEFAULT_FORWARDS, PORTAL as DEFAULT_PORTAL } from "./config.js";

// ── DOM ───────────────────────────────────────────────────────────
const $bar = document.getElementById("bar");
const $barStep = document.getElementById("bar-step");

const $stepPortal = document.getElementById("step-portal");
const $stepGateway = document.getElementById("step-gateway");
const $stepProgress = document.getElementById("step-progress");
const $stepConnected = document.getElementById("step-connected");
const $stepError = document.getElementById("step-error");

const $portal = document.getElementById("portal");
const $connect = document.getElementById("connect");
const $forwards = document.getElementById("forwards");
const $fwdCount = document.getElementById("fwd-count");
const $newHost = document.getElementById("new-host");
const $newPort = document.getElementById("new-port");
const $add = document.getElementById("add");

const $gwList = document.getElementById("gw-list");
const $gwBack = document.getElementById("gw-back");
const $gwConfirm = document.getElementById("gw-confirm");

const $progKicker = document.getElementById("prog-kicker");
const $progTitle = document.getElementById("prog-title");
const $progDetail = document.getElementById("prog-detail");

const $connGw = document.getElementById("conn-gw");
const $sshCmd = document.getElementById("ssh-cmd");
const $hostsCmd = document.getElementById("hosts-cmd");
const $forwardTable = document.getElementById("forward-table");
const $disconnect = document.getElementById("disconnect");

const $errMsg = document.getElementById("err-msg");
const $errRetry = document.getElementById("err-retry");

// ── view state ────────────────────────────────────────────────────
let selectedGateway = null;

function showStep(name) {
  for (const el of [$stepPortal, $stepGateway, $stepProgress, $stepConnected, $stepError]) {
    el.classList.remove("active");
  }
  document.getElementById(`step-${name}`).classList.add("active");

  const labels = {
    portal: "step 1 / 3 — portal",
    gateway: "step 2 / 3 — gateway",
    progress: "working",
    connected: "active",
    error: "failed",
  };
  $barStep.textContent = labels[name] || name;

  $bar.classList.toggle("connected", name === "connected");
  $bar.classList.toggle("error", name === "error");
  $bar.classList.toggle("busy", name === "progress" || name === "portal" || name === "gateway");
}

function showProgress(title, detail, kicker = "Working") {
  $progKicker.textContent = kicker;
  $progTitle.textContent = title;
  $progDetail.textContent = detail || "";
  showStep("progress");
  startWorkingAnim();
  // Snap phase indicators to the closest matching label.
  setActivePhaseFromTitle(title);
}

// ── ARPA-NOC working animation ────────────────────────────────────
let _animTickHandle = null;
let _animStart = 0;
let _animFrames = 0;

function genHexStream(seed) {
  // Deterministic-ish but visually-noisy hex pairs. Span ~200 bytes
  // so the strip is comfortably wider than 2× the wire.
  const out = [];
  let s = seed | 0;
  for (let i = 0; i < 220; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const hex = ((s >> 8) & 0xff).toString(16).padStart(2, "0");
    out.push(hex);
  }
  return out.join(" ");
}

function startWorkingAnim() {
  // Fill the hex strips once (cheap, mostly static aside from the
  // CSS translate animation).
  const hexUp = document.getElementById("hex-up");
  const hexDn = document.getElementById("hex-dn");
  if (hexUp && !hexUp.dataset.filled) {
    const a = genHexStream(0xa1b2);
    hexUp.textContent = a + "  " + a;
    hexUp.dataset.filled = "1";
  }
  if (hexDn && !hexDn.dataset.filled) {
    const b = genHexStream(0x5e7d);
    hexDn.textContent = b + "  " + b;
    hexDn.dataset.filled = "1";
  }

  // Counter ticks at 20Hz; dirt-cheap on a popup.
  if (_animTickHandle) return;
  _animStart = performance.now();
  _animFrames = 0;
  const $f = document.getElementById("ctr-frames");
  const $e = document.getElementById("ctr-elapsed");
  _animTickHandle = setInterval(() => {
    _animFrames++;
    if ($f) $f.textContent = String(_animFrames).padStart(5, "0");
    if ($e) {
      const ms = performance.now() - _animStart;
      const sec = Math.floor(ms / 1000);
      const cs = Math.floor((ms % 1000) / 10);
      const mm = String(Math.floor(sec / 60)).padStart(2, "0");
      const ss = String(sec % 60).padStart(2, "0");
      $e.textContent = `${mm}:${ss}.${String(cs).padStart(2, "0")}`;
    }
  }, 50);
}

function stopWorkingAnim() {
  if (_animTickHandle) {
    clearInterval(_animTickHandle);
    _animTickHandle = null;
  }
}

// Map the textual progress-title to a phase row. Best-effort.
function setActivePhaseFromTitle(title) {
  const phases = document.querySelectorAll(".phase");
  if (!phases.length) return;
  const t = (title || "").toLowerCase();
  let idx = 0;
  if (/saml|portal/i.test(t)) idx = 0;
  else if (/getconfig|portal getconfig/i.test(t)) idx = 1;
  else if (/gateway login/i.test(t)) idx = 2;
  else if (/hip/i.test(t)) idx = 3;
  else if (/provision|tunnel|bastion/i.test(t)) idx = 4;
  else if (/forward|download|key/i.test(t)) idx = 5;
  phases.forEach((p, i) => {
    p.classList.toggle("active", i === idx);
    p.classList.toggle("done", i < idx);
  });
}

function showError(msg) {
  $errMsg.textContent = msg || "Unknown error.";
  showStep("error");
}

// ── forwards ──────────────────────────────────────────────────────
async function loadForwards() {
  const { forwards } = await chrome.storage.local.get("forwards");
  return Array.isArray(forwards) ? forwards : DEFAULT_FORWARDS.slice();
}

async function saveForwards(forwards) {
  await chrome.storage.local.set({ forwards });
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderForwardTable(table) {
  $forwardTable.innerHTML = "";
  if (!table.length) {
    $forwardTable.textContent = "(no forwards configured)";
    return;
  }
  for (const row of table) {
    const localUrl = row.localhost_url || row.url || "";
    const cleanUrl = row.clean_url || row.url || "";
    const div = document.createElement("div");
    div.className = "forward";
    div.style.padding = "10px 12px";
    div.style.borderBottom = "1px solid var(--border)";
    div.style.background = "var(--surface)";
    div.style.fontSize = "12px";
    div.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">
        <span style="font-weight:600;">${escapeHTML(row.hostname)}</span>
        <span style="color:var(--text-dim);font-family:var(--font-mono);font-size:10px;">${row.local_port}→${row.remote_port}</span>
      </div>
      <div style="font-family:var(--font-mono);font-size:11px;line-height:1.7;">
        <div>
          <span style="color:var(--ok);font-size:9px;letter-spacing:0.16em;text-transform:uppercase;">recommended</span><br>
          <a href="${escapeHTML(cleanUrl)}" target="_blank" style="color:var(--orange-deep);">${escapeHTML(cleanUrl)}</a>
          <span style="color:var(--text-faint);font-size:10px;">cert valid (after step 2)</span>
        </div>
        <div style="margin-top:4px;">
          <span style="color:var(--alert);font-size:9px;letter-spacing:0.16em;text-transform:uppercase;">cert warning</span><br>
          <a href="${escapeHTML(localUrl)}" target="_blank" style="color:var(--text-dim);">${escapeHTML(localUrl)}</a>
          <span style="color:var(--text-faint);font-size:10px;">browser will refuse — accept manually</span>
        </div>
      </div>
    `;
    $forwardTable.appendChild(div);
  }
}

function renderForwards(list) {
  $forwards.innerHTML = "";
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const row = document.createElement("div");
    row.className = "forward";
    row.innerHTML = `
      <span class="name">${escapeHTML(f.hostname)}</span>
      <span class="port">:${f.port}</span>
      <button class="danger" data-i="${i}" title="remove">×</button>
    `;
    $forwards.appendChild(row);
  }
  $fwdCount.textContent = String(list.length);
  $forwards.querySelectorAll("button.danger").forEach((b) => {
    b.addEventListener("click", async () => {
      const i = Number(b.dataset.i);
      const cur = await loadForwards();
      cur.splice(i, 1);
      await saveForwards(cur);
      renderForwards(cur);
    });
  });
}

$add.addEventListener("click", async () => {
  const hostname = $newHost.value.trim();
  const port = parseInt($newPort.value, 10);
  if (!hostname || !port || port < 1 || port > 65535) return;
  const cur = await loadForwards();
  if (cur.some((f) => f.hostname === hostname && f.port === port)) return;
  cur.push({ hostname, port, label: `${hostname}:${port}` });
  await saveForwards(cur);
  $newHost.value = "";
  $newPort.value = "";
  renderForwards(cur);
});

// ── portal persistence ────────────────────────────────────────────
async function loadPortal() {
  const { portal } = await chrome.storage.local.get("portal");
  return portal || DEFAULT_PORTAL;
}

$portal.addEventListener("input", async () => {
  const v = $portal.value.trim();
  if (!v) return;
  await chrome.storage.local.set({ portal: v });
});

// ── connect intent ────────────────────────────────────────────────
$connect.addEventListener("click", async () => {
  const portal = $portal.value.trim();
  if (!portal) {
    showError("Enter a portal hostname first.");
    return;
  }
  await chrome.storage.local.set({ portal });
  const forwards = await loadForwards();
  showProgress(
    "Asking portal for SAML…",
    `Calling ${portal}/global-protect/prelogin.esp`,
    "Step 1 — Portal",
  );
  await chrome.runtime.sendMessage({ kind: "start", forwards });
});

// ── gateway picker ────────────────────────────────────────────────
async function showGatewayPicker() {
  const { availableGateways: raw = [], gateway: saved } = await chrome.storage.local.get([
    "availableGateways",
    "gateway",
  ]);
  // Belt-and-suspenders filter: storage from older builds can hold
  // raw entries (including PAN's "Any" placeholder). Drop anything
  // that isn't a hostname-shaped string and dedupe.
  const availableGateways = [
    ...new Set(raw.filter((g) => typeof g === "string" && g.includes("."))),
  ];
  $gwList.innerHTML = "";
  selectedGateway =
    (saved && availableGateways.includes(saved) ? saved : availableGateways[0]) || null;

  for (const g of availableGateways) {
    const row = document.createElement("div");
    row.className = "gw-item" + (g === selectedGateway ? " selected" : "");
    row.dataset.host = g;
    row.innerHTML = `
      <span>${escapeHTML(g)}</span>
      ${g === saved ? '<span class="badge">last used</span>' : ""}
    `;
    row.addEventListener("click", () => {
      selectedGateway = g;
      $gwList.querySelectorAll(".gw-item").forEach((el) =>
        el.classList.toggle("selected", el.dataset.host === g),
      );
    });
    $gwList.appendChild(row);
  }
  showStep("gateway");
}

$gwBack.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ kind: "stop" }); // tear down half-flow
  showStep("portal");
});

$gwConfirm.addEventListener("click", async () => {
  if (!selectedGateway) return;
  await chrome.storage.local.set({ gateway: selectedGateway });
  showProgress(
    "Provisioning bastion…",
    "Bringing up openconnect inside a netns + spawning socat per forward.",
    "Step 3 — Bastion",
  );
  await chrome.runtime.sendMessage({ kind: "resume-after-gateway-pick" });
});

// ── disconnect ────────────────────────────────────────────────────
$disconnect.addEventListener("click", async () => {
  showProgress("Disconnecting…", "POST /api/disconnect");
  await chrome.runtime.sendMessage({ kind: "stop" });
});

// ── error retry ───────────────────────────────────────────────────
$errRetry.addEventListener("click", () => {
  showStep("portal");
});

// ── react to background state pushes ──────────────────────────────
function applyState(s) {
  if (!s) return;
  // Any non-progress state should stop the noisy counter.
  if (s.cls === "err" || s.connected || (!s.busy && !s.connected)) {
    stopWorkingAnim();
  }
  if (s.cls === "err") {
    showError(s.text || "");
    return;
  }
  if (s.connected) {
    $connGw.textContent = s.gateway || s.bastionUsername || "";
    $sshCmd.textContent = s.sshCmd || "";
    $hostsCmd.textContent = s.hostsCmd || "";
    renderForwardTable(s.forwardTable || []);
    showStep("connected");
    return;
  }
  if (s.text === "Pick a gateway") {
    showGatewayPicker();
    return;
  }
  if (s.busy) {
    showProgress(s.text || "Working…", s.detail || "");
    return;
  }
  // Idle.
  showStep("portal");
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.kind === "state") applyState(msg);
});

// ── copy-to-clipboard buttons on every <pre class="cmd"> ─────────
document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".copy-btn");
  if (!btn) return;
  const targetId = btn.dataset.target;
  const node = document.getElementById(targetId);
  if (!node) return;
  try {
    await navigator.clipboard.writeText(node.textContent);
    const orig = btn.textContent;
    btn.textContent = "copied";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove("copied");
    }, 1100);
  } catch {}
});

// ── boot ──────────────────────────────────────────────────────────
(async () => {
  $portal.value = await loadPortal();
  renderForwards(await loadForwards());
  const reply = await chrome.runtime.sendMessage({ kind: "get-state" });
  applyState(reply?.state);
})();
