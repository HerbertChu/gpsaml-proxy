// gpsaml-bastion background service worker.
//
// Walks the PAN GlobalProtect SAML flow, captures the portal
// Prelogin-Cookie via webRequest header sniffing, runs portal
// getconfig + gateway login (plain HTTPS), then hands the resulting
// authcookie to a gpsaml-proxy bastion which sets up openconnect +
// socat in a netns and returns a one-shot .command download URL.
//
// This is functionally a port of gpsaml/src/endpoints.ts (TypeScript,
// Electron) into MV3 service-worker JS. No Electron / no sshuttle.

import {
  PORTAL as DEFAULT_PORTAL,
  GATEWAY_FINGERPRINT as DEFAULT_GATEWAY_FINGERPRINT,
  BASTION as DEFAULT_BASTION,
  BASTION_SECRET as DEFAULT_BASTION_SECRET,
  DEFAULT_FORWARDS,
} from "./config.js";

// Runtime config — populated from chrome.storage.local on every SW
// (re)start so values survive SW eviction. The Bastion config UI in
// the popup writes to the same storage keys; storage.onChanged below
// keeps these mutable globals in sync without a SW reload.
let PORTAL = DEFAULT_PORTAL;
let GATEWAY = DEFAULT_PORTAL;
let GATEWAY_FINGERPRINT = DEFAULT_GATEWAY_FINGERPRINT;
let BASTION = DEFAULT_BASTION;
let BASTION_SECRET = DEFAULT_BASTION_SECRET;

async function loadRuntimeConfig() {
  const v = await chrome.storage.local.get([
    "portal",
    "bastion",
    "bastionSecret",
    "gatewayFingerprint",
  ]);
  if (v.portal) {
    PORTAL = v.portal;
    GATEWAY = v.portal; // single-host PAN setup; gateway picker can refine later
  }
  if (v.bastion) BASTION = v.bastion;
  if (v.bastionSecret) BASTION_SECRET = v.bastionSecret;
  if (v.gatewayFingerprint) GATEWAY_FINGERPRINT = v.gatewayFingerprint;
}

loadRuntimeConfig();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (
    changes.portal || changes.bastion || changes.bastionSecret ||
    changes.gatewayFingerprint
  ) {
    loadRuntimeConfig();
  }
});
restoreState();

// ── persistent UI window (instead of browserAction popup) ─────────
//
// browserAction popups close on focus loss — terrible for a flow that
// needs the SAML window in front. Open the popup HTML in its own
// chrome.windows.create({type:"popup"}) so it stays visible while
// the user works in the SAML window, and survives SW evictions.
let popupWindowId = null;

chrome.action.onClicked.addListener(async () => {
  if (popupWindowId !== null) {
    try {
      await chrome.windows.update(popupWindowId, { focused: true });
      return;
    } catch {
      popupWindowId = null;
    }
  }

  const W = 400;
  const H = 620;
  // Center on the primary display. system.display gives us the
  // work area bounds (excluding dock / taskbar). Falling back to a
  // typical 1440×900 if the API somehow misbehaves so the popup
  // still opens.
  let left = 100;
  let top = 100;
  try {
    const displays = await chrome.system.display.getInfo();
    const primary = displays.find((d) => d.isPrimary) || displays[0];
    if (primary?.workArea) {
      left = Math.round(primary.workArea.left + (primary.workArea.width - W) / 2);
      top = Math.round(primary.workArea.top + (primary.workArea.height - H) / 2);
    }
  } catch {}

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("popup.html"),
    type: "popup",
    width: W,
    height: H,
    left,
    top,
    focused: true,
  });
  popupWindowId = win.id;
});

chrome.windows.onRemoved.addListener((id) => {
  if (id === popupWindowId) popupWindowId = null;
});

// ── tiny state machine ─────────────────────────────────────────────
// We don't bother with chrome.storage for live state; the service
// worker stays warm through the SAML flow because chrome keeps it
// alive while listeners (webRequest) are active.
const state = {
  busy: false,
  connected: false,
  text: "Idle.",
  cls: "",
  // Filled in during SAML capture, cleared on stop.
  preloginCookie: null,
  samlUsername: null,
  // Window opened for SAML (type=popup, dedicated). We close it
  // after capturing the cookie.
  samlWindowId: null,
  samlTabId: null,
  // Username returned by bastion after openconnect (may differ from
  // samlUsername if the bastion derives a sandbox username).
  bastionUsername: null,
  // List of {hostname, port} chosen at start time.
  forwards: [],
  // Manual fallback command shown when user can't / won't double-click
  // the .command (no sudo, etc.).
  manualCmd: null,
};

function setState(patch) {
  Object.assign(state, patch);
  // Persist so a SW eviction (~30s idle) doesn't blank the UI.
  chrome.storage.local.set({ state }).catch(() => {});
  chrome.runtime.sendMessage({ kind: "state", ...state }).catch(() => {});
}

async function restoreState() {
  try {
    const { state: saved } = await chrome.storage.local.get("state");
    if (saved) {
      // Don't restore in-flight tabs/windows (they're gone after a
      // restart). Keep terminal state — connected/disconnected and
      // the artefacts the UI needs.
      Object.assign(state, saved, {
        samlTabId: null,
        samlWindowId: null,
        // If the SW was evicted mid-flow, treat us as "not in
        // progress" so the user can restart.
        busy: saved.connected ? false : false,
      });
    }
  } catch {}
}

// ── webRequest: capture portal Prelogin-Cookie / Saml-Username ─────
//
// PAN's portal returns these as HTTP response headers on the final
// hop of the SAML flow. The browser DOM has no way to read them
// (response headers aren't exposed to navigation-result JS), so MV3
// webRequest is the only option.
// Match every https origin; we filter inside by checking the URL
// against the runtime PORTAL value (which the user can change in
// the popup). Listening on a fixed `https://${PORTAL}/*` would
// freeze that filter at module-load time.
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    // No busy guard — MV3 SW gets evicted after ~30s idle, so by the
    // time SAML callback comes back state.busy may have been reset
    // to its module-default (false). Better to react to the header
    // unconditionally and let finishLoginAfterSaml's idempotency
    // handle dupes.
    if (state.preloginCookie) return;
    let u;
    try {
      u = new URL(details.url);
    } catch {
      return;
    }
    if (u.hostname !== PORTAL) return;

    const headers = details.responseHeaders || [];
    const headerNames = headers.map((h) => h.name).join(", ");
    console.log(
      `[gpsaml-bastion] portal ${details.method} ${u.pathname} ${details.statusCode} headers=[${headerNames}]`,
    );

    const get = (name) =>
      headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
    const cookie = get("Prelogin-Cookie");
    const user = get("Saml-Username");
    if (cookie && user) {
      console.log("[gpsaml-bastion] captured portal SAML cookie for", user);
      state.preloginCookie = cookie;
      state.samlUsername = user;
      finishLoginAfterSaml().catch((e) => onError("post-SAML chain failed", e));
    }
  },
  { urls: ["https://*/*"] },
  ["responseHeaders"]
);

// ── connect / disconnect intents from popup ────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.kind === "get-state") {
    reply({ state });
    return false;
  }
  if (msg.kind === "start") {
    state.forwards = Array.isArray(msg.forwards) && msg.forwards.length
      ? msg.forwards
      : DEFAULT_FORWARDS;
    startLogin().catch((e) => onError("start failed", e));
    reply({ ok: true });
    return false;
  }
  if (msg.kind === "stop") {
    disconnect().finally(() => reply({ ok: true }));
    return true; // async response
  }
  if (msg.kind === "resume-after-gateway-pick") {
    (async () => {
      const { gateway } = await chrome.storage.local.get("gateway");
      if (!gateway || !state.gateways || !state.gateways.includes(gateway)) {
        onError("resume", new Error("no valid gateway picked"));
        return;
      }
      GATEWAY = gateway;
      try {
        await finishLoginWithGateway();
      } catch (e) {
        onError("post-gateway-pick chain failed", e);
      }
    })();
    reply({ ok: true });
    return false;
  }
  return false;
});

// ── flow ───────────────────────────────────────────────────────────
async function startLogin() {
  if (state.busy) return;
  resetState();
  await loadRuntimeConfig();
  setState({ busy: true, text: `Asking portal ${PORTAL} for SAML request…` });
  const samlRequest = await portalPrelogin();
  setState({ text: "Opening SAML window — sign in…" });
  await openSamlTab(samlRequest);
  // From here: webRequest listener captures cookie → finishLoginAfterSaml.
}

async function finishLoginAfterSaml() {
  setState({ text: "Closing SAML window…" });
  if (state.samlWindowId !== null) {
    try {
      await chrome.windows.remove(state.samlWindowId);
    } catch {}
    state.samlWindowId = null;
    state.samlTabId = null;
  }

  setState({ text: "Portal getconfig…" });
  const { portalUserAuthCookie, gateways } = await portalGetConfig(
    state.preloginCookie,
    state.samlUsername,
  );

  // Stash the secrets we need to resume after gateway pick.
  state.portalUserAuthCookie = portalUserAuthCookie;
  state.gateways = gateways;

  // If user has a saved gateway and it's in the list, skip the
  // picker and continue. Otherwise hand control to the popup.
  const { gateway: savedGateway } = await chrome.storage.local.get("gateway");
  if (savedGateway && gateways.includes(savedGateway)) {
    GATEWAY = savedGateway;
    await finishLoginWithGateway();
  } else {
    setState({ text: "Pick a gateway", busy: false });
  }
}

async function finishLoginWithGateway() {
  console.log("[gpsaml-bastion] using gateway:", GATEWAY);
  setState({ busy: true, text: `Gateway login (${GATEWAY})…` });
  const loginResp = await gatewayLogin(
    state.portalUserAuthCookie,
    state.samlUsername,
  );

  setState({ text: "Provisioning bastion…" });
  const result = await callBastion(loginResp);

  setState({ text: "Downloading SSH key…" });
  await downloadSshKey(result.private_key);

  state.bastionUsername = loginResp.user;
  state.gatewayLabel = GATEWAY;
  state.sshCmd = result.ssh_cmd;
  state.hostsCmd = result.hosts_cmd;
  state.forwardTable = result.forwards;
  setState({
    busy: false,
    connected: true,
    gateway: GATEWAY,
    sshCmd: result.ssh_cmd,
    hostsCmd: result.hosts_cmd,
    forwardTable: result.forwards,
    text: "Connected.",
    cls: "ok",
  });
}

async function disconnect() {
  if (state.bastionUsername) {
    try {
      const body = JSON.stringify({ username: state.bastionUsername });
      const sig = await hmacHex(BASTION_SECRET, body);
      await fetch(`${BASTION}/api/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-GPSAML-Signature": sig },
        body,
      });
    } catch (e) {
      console.warn("[gpsaml-bastion] /api/disconnect failed:", e);
    }
  }
  resetState();
  setState({ busy: false, connected: false, text: "Disconnected.", cls: "" });
}

// ── PAN protocol ──────────────────────────────────────────────────
// Extract the (single) text content of an XML/HTML element. PAN's
// XML is simple enough that a regex beats pulling in a parser; this
// also dodges the fact that MV3 service workers have no DOMParser.
// PAN's tag names contain hyphens (saml-request, saml-request-timeout
// etc.), so a naive `\b` after the tag name happily matches a longer
// tag — `saml-request` would match `saml-request-timeout` first.
// Force the next char to be `>` or whitespace (attribute boundary).
function tagText(xml, tag) {
  const re = new RegExp(
    `<\\s*${tag}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\s*/\\s*${tag}\\s*>`,
    "i",
  );
  const m = xml.match(re);
  if (!m) return null;
  return (m[1] !== undefined ? m[1] : m[2] || "").trim();
}

function tagTextAll(xml, tag) {
  const re = new RegExp(
    `<\\s*${tag}(?:\\s[^>]*)?>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\s*/\\s*${tag}\\s*>`,
    "ig",
  );
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.push((m[1] !== undefined ? m[1] : m[2] || "").trim());
  }
  return out;
}

async function portalPrelogin() {
  const url =
    `https://${PORTAL}/global-protect/prelogin.esp?` +
    new URLSearchParams({
      tmp: "tmp",
      "kerberos-support": "yes",
      "ipv6-support": "yes",
      clientVer: "4100",
      clientos: "Linux",
    });
  const resp = await fetch(url, { method: "POST" });
  if (!resp.ok) throw new Error(`portal prelogin HTTP ${resp.status}`);
  const xml = await resp.text();
  const status = tagText(xml, "status");
  if (status !== "Success") {
    const msg = tagText(xml, "msg");
    throw new Error(`portal prelogin failed: ${msg || status}`);
  }
  const samlRequest = tagText(xml, "saml-request");
  const authMethod = tagText(xml, "saml-auth-method");
  if (!samlRequest) throw new Error("portal prelogin: no saml-request");
  return { samlRequest, isRedirect: (authMethod || "REDIRECT") === "REDIRECT" };
}

async function openSamlTab({ samlRequest, isRedirect }) {
  // REDIRECT: samlRequest is usually a base64-encoded URL, but some
  // PAN deployments return the URL plain. POST: it's a base64 blob
  // of HTML that auto-submits to the IdP.
  let url;
  if (isRedirect) {
    let decoded;
    try {
      decoded = atob(samlRequest);
    } catch {
      decoded = null;
    }
    // Heuristic: a real URL starts with http(s):// and probably
    // contains "?" for query. atob output that doesn't look like a
    // URL means the input was already plain — fall through.
    const looksUrl = (s) => /^https?:\/\//i.test(s);
    if (decoded && looksUrl(decoded.trim())) {
      url = decoded.trim();
    } else if (looksUrl(samlRequest.trim())) {
      url = samlRequest.trim();
    } else {
      throw new Error(
        `saml-request didn't decode to a URL. ` +
          `length=${samlRequest.length} sample=${samlRequest.slice(0, 80)}`,
      );
    }
  } else {
    // Inline HTML — load via data: URL.
    url = "data:text/html;base64," + samlRequest;
  }
  console.log("[gpsaml-bastion] opening SAML window:", url.slice(0, 120));
  // Dedicated popup window (not a normal tab) so the SAML flow feels
  // like a child of the extension rather than littering the user's
  // browsing tabs. Sized to fit a typical IdP login form.
  const win = await chrome.windows.create({
    url,
    type: "popup",
    width: 480,
    height: 640,
    focused: true,
  });
  state.samlWindowId = win.id;
  state.samlTabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
}

async function portalGetConfig(preloginCookie, user) {
  const body = new URLSearchParams({
    "prelogin-cookie": preloginCookie,
    user,
  });
  const resp = await fetch(`https://${PORTAL}/global-protect/getconfig.esp`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) throw new Error(`portal getconfig HTTP ${resp.status}`);
  const xml = await resp.text();
  const portalUserAuthCookie = tagText(xml, "portal-userauthcookie");
  if (!portalUserAuthCookie || portalUserAuthCookie === "empty") {
    throw new Error("portal getconfig: missing portal-userauthcookie");
  }

  // Pull the gateway list. PAN's getconfig wraps gateways like:
  //   <gateways>
  //     <external><list>
  //       <entry name="lisle-vpn.example.com">…</entry>
  //       <entry name="taiwan-vpn.example.com">…</entry>
  //     </list></external>
  //     <preferred><entry name="Any">…</entry></preferred>
  //   </gateways>
  // We only want the external list — preferred contains "Any" which
  // isn't a real hostname and pollutes the dropdown.
  const externalSection =
    tagText(tagText(xml, "gateways") || "", "external") || "";
  const listSection = tagText(externalSection, "list") || "";
  const rawGateways = [
    ...listSection.matchAll(/<entry\s+name="([^"]+)"/g),
  ].map((m) => m[1]);
  // Filter to entries that look like hostnames (have a dot) and dedupe.
  const gateways = [...new Set(rawGateways.filter((g) => g.includes(".")))];
  console.log("[gpsaml-bastion] gateways from portal:", gateways);
  await chrome.storage.local.set({ availableGateways: gateways });

  return { portalUserAuthCookie, gateways };
}

async function gatewayLogin(portalUserAuthCookie, user) {
  // Match gpsaml's exact wire format (form fields + casing). PAN's
  // gateway is fussy about which fields are present and rejects
  // missing ones with a non-standard 512.
  const body = new URLSearchParams({
    "prot": "https:",
    "server": GATEWAY,
    "inputStr": "",
    "jnlpReady": "jnlpReady",
    "user": user,
    "passwd": "",
    "computer": "browser-extension",
    "ok": "Login",
    "direct": "yes",
    "clientVer": "4100",
    "os-version": "Linux",
    "clientos": "Linux",
    "portal-userauthcookie": portalUserAuthCookie,
    "portal-prelogonuserauthcookie": "empty",
  });
  const resp = await fetch(`https://${GATEWAY}/ssl-vpn/login.esp`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const xml = await resp.text();
  if (!resp.ok) {
    console.error("[gpsaml-bastion] gateway login body:", xml.slice(0, 800));
    throw new Error(`gateway login HTTP ${resp.status}: ${xml.slice(0, 200)}`);
  }
  const args = tagTextAll(xml, "argument");
  if (args.length < 8) {
    throw new Error(`gateway login: only ${args.length} jnlp arguments (expected 8+)`);
  }
  // Mirrors __createLoginResp in gpsaml's endpoints.ts. The JNLP
  // argument list is positional — the bastion's openconnect cookie
  // builder needs all of these fields.
  return {
    authcookie: args[1],
    portal: args[3],
    user: args[4],
    domain: args[7],
    "preferred-ip": args[15] || "",
    computer: "browser-extension",
  };
}

// ── bastion call ───────────────────────────────────────────────────
async function callBastion(loginResp) {
  const cookieParams = new URLSearchParams(loginResp);
  const body = JSON.stringify({
    username: loginResp.user,
    authcookie: cookieParams.toString(),
    gateway: GATEWAY,
    fingerprint: GATEWAY_FINGERPRINT,
    forwards: state.forwards.map((f) => ({
      hostname: f.hostname,
      port: f.port,
    })),
  });
  const sig = await hmacHex(BASTION_SECRET, body);

  const resp = await fetch(`${BASTION}/api/connect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GPSAML-Signature": sig,
    },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`bastion /api/connect HTTP ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function downloadSshKey(privateKey) {
  // chrome.downloads can take a data: URL pointing at our key body.
  // Files always land in the user's Downloads folder (we can't
  // chmod 600 from here — user does that manually before ssh).
  const dataUrl =
    "data:application/octet-stream;base64," +
    btoa(unescape(encodeURIComponent(privateKey)));
  await chrome.downloads.download({
    url: dataUrl,
    filename: "gpsaml-bastion-id",
    saveAs: false,
    conflictAction: "overwrite",
  });
}

// ── helpers ───────────────────────────────────────────────────────
async function hmacHex(secret, body) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function resetState() {
  state.preloginCookie = null;
  state.samlUsername = null;
  state.samlTabId = null;
  state.samlWindowId = null;
  state.bastionUsername = null;
  state.portalUserAuthCookie = null;
  state.gateways = null;
  state.gatewayLabel = null;
}

function onError(where, e) {
  console.error("[gpsaml-bastion]", where, e);
  resetState();
  setState({
    busy: false,
    connected: false,
    text: `${where}: ${e?.message || e}`,
    cls: "err",
  });
}
