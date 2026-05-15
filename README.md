# gpsaml-proxy

A self-hosted **GlobalProtect SAML bastion** + **Chrome extension** that
gives a laptop user access to corp-internal HTTP / SSH services without
running any VPN client on the laptop.

The browser drives the SAML auth, the bastion runs `openconnect` inside
a per-user network namespace, and the laptop reaches the result through
plain `ssh -L` port forwards.

```
┌──────── laptop ────────┐                       ┌─────── bastion ───────┐
│                        │                       │                       │
│  ┌──────────────────┐  │  ① portal SAML        │  ┌────────────────┐   │
│  │ Chrome extension │──┼───► Microsoft Entra   │  │ Caddy (LE)     │   │
│  │ • walks SAML     │  │  ② Prelogin-Cookie    │  │ + gunicorn     │   │
│  │ • captures cookie│  │  ③ getconfig.esp      │  │ + Flask /api/* │   │
│  │ • POST authcookie│──┼───► HTTPS to bastion ─┼──►                │   │
│  └────────┬─────────┘  │                       │  └────────┬───────┘   │
│           │            │                       │           │           │
│           ▼            │  ④ private SSH key    │  ┌────────▼───────┐   │
│  ┌──────────────────┐  │     + ssh -L command  │  │provision (sudo)│   │
│  │ Downloads/       │◄─┼─────────────────────  │  │ • netns ns_<u> │   │
│  │ gpsaml-bastion-id│  │                       │  │ • veth + NAT   │   │
│  └────────┬─────────┘  │                       │  │ • per-user key │   │
│           │            │                       │  │ • openconnect  │   │
│           ▼            │  ⑤ ssh -L 8443:…:443  │  │ • socat/forward│   │
│   ssh -N -L … user@gpsaml.<your-domain> ───────┼──►                │   │
│                        │                       │  └───┬────┬───────┘   │
│  https://corp:8443/    │                       │      │    │           │
│  (via /etc/hosts → 127.0.0.1)                  │ ┌────▼─┐ ┌▼──────┐    │
│                        │                       │ │socat │ │openvpn│    │
└────────────────────────┘                       │ │:443  │ │tun0   │    │
                                                 │ └────┬─┘ └───┬───┘    │
                                                 │      │       │        │
                                                 │      ▼       ▼        │
                                                 │   ╔═══════════════╗   │
                                                 │   ║   ns_<user>   ║───┼─► corp
                                                 │   ╚═══════════════╝   │
                                                 └───────────────────────┘
```

## What you get

- **No VPN client on the laptop.** No `openconnect`, no `sshuttle`, no
  Electron app. The browser does SAML, OpenSSH does the tunnel —
  both ship with macOS.
- **Per-user isolation.** Every authenticated user lands in their own
  Linux network namespace with its own openconnect tunnel and its own
  socat forwarders. Two users can't see each other's traffic, can't
  step on each other's routes, can't impersonate each other to corp
  services.
- **Auto-renewed TLS.** Caddy in front of gunicorn handles
  Let's Encrypt ACME HTTP-01 with no cron, no certbot, no manual touch.
- **macOS HIP segfault, gone.** The HIP report runs on the Linux
  bastion where openconnect mainline behaves; the laptop never sees
  openconnect at all.

## Repository layout

| Path | What lives there |
| --- | --- |
| `bastion/web/app.py` | Flask + gunicorn API. HMAC-validates client requests, calls `provision`, returns the SSH key + recommended `ssh -L` command. |
| `bastion/bin/provision` | Privileged Python helper. Owns user creation, netns / veth / NAT plumbing, openconnect lifecycle, socat forwarders, per-user `authorized_keys` + sudoers. Web invokes via NOPASSWD sudo. |
| `bastion/bin/vpnc-script-netns` | Wrapper around the standard `vpnc-script` that pushes corp DNS into `/etc/netns/<ns>/resolv.conf` instead of the host's `/etc/resolv.conf`. |
| `bastion/bin/enter-ns` | SSH `ForceCommand` target. Drops into the user's netns + drops privileges. |
| `bastion/bin/deploy.sh` | Idempotent installer for `socat`, Caddy, systemd units, sudoers, secret. |
| `bastion/bin/cloudflare-dns.sh` | One-shot Cloudflare A-record manager (token via env or AWS Secrets Manager). |
| `bastion/etc/Caddyfile` | TLS termination + reverse proxy to gunicorn. |
| `bastion/etc/sshd_config-gpsaml.conf` | Group-scoped sshd block: pubkey-only, no PTY, no agent / X11 / R / D forwarding; `AllowTcpForwarding local` for `ssh -L`. |
| `bastion/etc/sudoers-web.conf` | Lets the unprivileged `gpw` user run `provision` as root. |
| `bastion/etc/forwards.json` | Optional fallback list when the extension doesn't send a forwards array. |
| `bastion/static/index.html` | Landing page with the extension download link + setup instructions. |
| `bastion/systemd/gpsaml-proxy-web.service` | systemd unit for the web tier. |
| `extension/manifest.json` | Manifest V3 + `<all_urls>` host_permissions + `system.display`. |
| `extension/background.js` | SAML capture (webRequest header sniff), full PAN GP protocol port (prelogin → getconfig → gateway login), bastion call, key download, persistent state, centered popup window. |
| `extension/popup.html` / `popup.js` | Multi-step UI (portal → gateway → working → connected) styled to match gpsaml's cream + orange + stamped-button motif. |
| `extension/rules.json` | declarativeNetRequest static rules — sets `User-Agent: PAN GlobalProtect` for `/global-protect/*` and `/ssl-vpn/*` (browser fetch can't set this header directly). |
| `extension/config.js` | Default values shown the first time the popup opens. Real per-user values are stored in `chrome.storage.local` via the **Bastion config** panel; fork + edit this file only if you want to bake them into the unpacked extension. |
| `docs/architecture.md` | Long-form design notes. |

## End-to-end flow

```
0. user installs the Chrome extension once
     ├── chrome://extensions → Developer mode → Load unpacked
     └── pin to toolbar

1. user clicks the extension icon → popup window opens (centered)
     ├── enters portal hostname, hits "Authenticate via SAML"
     ├── extension POSTs portal/global-protect/prelogin.esp
     │      User-Agent forced to "PAN GlobalProtect" via
     │      declarativeNetRequest (browser fetch can't set it directly)
     └── opens a dedicated popup window with the SAML URL

2. user authenticates with corp SSO (incl. MFA)
     └── extension's webRequest.onHeadersReceived listener catches the
         Prelogin-Cookie + Saml-Username headers from the portal's
         final response

3. extension chains the rest of the protocol off-thread:
     ├── portal /global-protect/getconfig.esp     → portalUserAuthCookie
     │                                              + gateways list
     └── gateway /ssl-vpn/login.esp               → JNLP authcookie

4. user picks a gateway from the list (saved for next time)

5. extension POSTs to bastion /api/connect with HMAC-SHA256 signature
     ├── username, authcookie, gateway, fingerprint, forwards
     └── bastion calls `sudo provision up <user> <cookie> <gw> <fpr>
         <forwards-json>`

6. provision (~2 s on a warm tunnel, ~170 s on a cold one):
     ├── ensures the gpsaml-users group + per-user account
     ├── builds netns ns_<user>, veth pair into default ns, NAT
     ├── generates ed25519 keypair, writes authorized_keys with
     │   ForceCommand=enter-ns ns_<user>
     ├── writes /etc/sudoers.d/gpsaml-<user> (visudo-validated)
     ├── ip netns exec openconnect --background --csd-wrapper=hipreport.sh
     │   …, with stdin/stdout/stderr=DEVNULL so the daemonized child
     │   doesn't keep the gunicorn pipe open and trip subprocess timeout
     ├── spawns one socat per requested forward inside the netns
     └── emits {private_key, ns_ip, forwards} JSON on stdout

7. bastion returns to the extension:
     ├── private_key       (one-shot)
     ├── ssh_user, ssh_host
     ├── forwards          (with localhost_url + clean_url per entry)
     ├── ssh_cmd           (recommended ssh -L command)
     └── hosts_cmd         (one-line-per-host /etc/hosts patch)

8. extension auto-downloads the SSH key to ~/Downloads/gpsaml-bastion-id

9. user pastes three commands from the popup (each has a Copy button):
     1. chmod 600 ~/Downloads/gpsaml-bastion-id
     2. echo '127.0.0.1 …' | sudo tee -a /etc/hosts        (per host)
     3. ssh -N -L … -i ~/Downloads/gpsaml-bastion-id user@bastion

10. user opens https://<corp-host>/ in the browser → ssh -L → veth →
    socat → openconnect → corp.
```

`Ctrl+C` in the SSH terminal disconnects locally; the **Disconnect**
button in the extension popup also POSTs `/api/disconnect` which tears
down the socat forwarders, openconnect, netns, veth, NAT, sudoers, and
authorized_keys for that user.

## Running it

### Prereqs

- A Linux VM with `openconnect` HEAD installed (mainline 9.12 segfaults
  on HIP-enforcing GlobalProtect gateways — use HEAD).
- A domain pointing at the VM (Caddy needs DNS resolving in order to
  acquire a Let's Encrypt cert via HTTP-01). An Elastic IP / similar
  is recommended so the cert and DNS record survive instance reboots.
- Cloudflare API token with **Zone:DNS:Edit** scope (optional — the
  deploy script can manage the A record for you, otherwise create it
  by hand).

### Bastion

```sh
# On the VM (Amazon Linux 2023 / Debian / Ubuntu):
sudo dnf install -y python3-virtualenv git    # or apt-get
git clone https://github.com/<you>/gpsaml-proxy.git
cd gpsaml-proxy
DOMAIN=gpsaml.your-domain.com bash bastion/bin/deploy.sh
```

`deploy.sh` is idempotent. It:

- Installs `socat`, `caddy` (static binary into `/usr/local/bin`).
- Drops `provision`, `app.py`, the static landing page, the extension
  source into `/opt/gpsaml-proxy/`.
- Generates a fresh shared secret at `/etc/gpsaml-proxy/secret` (mode
  `0640`, owner `gpw:gpw`) on first run.
- Lays down the Caddyfile, the systemd units, the sudoers drop-in.
- Restarts `gpsaml-proxy-web` and `caddy`.
- If `CLOUDFLARE_API_TOKEN` is set in the environment (or available at
  the AWS Secrets Manager id `gpsaml/cloudflare-api-token`), points the
  domain's A record at the VM's public IP and waits for propagation
  before Caddy retries ACME.

After it returns, `https://<your-domain>/healthz` should respond with
`{"ok":true}`.

### Extension

1. Download the latest extension zip from
   [Releases](https://github.com/HerbertChu/gpsaml-proxy/releases),
   or clone this repo and use `extension/` directly.
2. `chrome://extensions` → Developer mode → **Load unpacked** → pick
   the `extension/` folder. Pin it.
3. Click the extension icon. The first time, the popup will surface a
   **Bastion config needed** banner — expand the **Bastion config**
   panel and fill in:
   - **Bastion URL** → your bastion's HTTPS URL (e.g.
     `https://gpsaml.example.com`).
   - **Shared secret** → the value of `/etc/gpsaml-proxy/secret` on
     the bastion (`cat` it, paste here; lives only in `chrome.storage.local`).
   - **Gateway SHA-1 fingerprint** → your GP gateway's TLS cert fingerprint:
     ```sh
     openssl s_client -connect <gw>:443 </dev/null \
       | openssl x509 -fingerprint -sha1 -noout \
       | tr -d ':' | cut -d= -f2
     ```
4. Click **Save**. The banner clears and **Authenticate via SAML**
   unlocks.
5. Optional: tweak the **Forwards** list (defaults shipped with the
   extension). Type your portal hostname; click Authenticate.

Power-user alternative: edit `extension/config.js` directly to bake
defaults into the unpacked extension (useful for distributing a
pre-configured fork to your team). Storage values from the UI always
win over config.js.

### Per-user flow

Click the extension. Type the portal hostname (saved for next time).
Hit **Authenticate via SAML**. Sign in. Pick a gateway. Run the three
commands the popup shows. Open the corp URL in your browser. To
disconnect: `Ctrl+C` in the SSH terminal **and** click `Disconnect` in
the popup (the latter tears down the bastion-side state).

## Security notes

- **The shared secret is the entire authn boundary** between the
  extension and the bastion. Treat it like a credential — rotate by
  regenerating `/etc/gpsaml-proxy/secret` and re-entering the value
  in each user's extension via the **Bastion config** panel (or
  updating `BASTION_SECRET` for forks that bake defaults into
  `extension/config.js`).
- **The user's session inside the bastion is sandboxed** by:
  - sshd group-match: pubkey-only, no PTY, no agent / X11 / R / D
    forwarding (only `AllowTcpForwarding local`).
  - per-user `authorized_keys` with `command=enter-ns ns_<user>` —
    every SSH session enters the user's netns before running anything.
  - per-user sudoers drop-in scoped to a small command set; visudo
    validates before install.
- **The bastion's web tier runs as `gpw` (unprivileged)**. The only
  way `gpw` reaches root is the NOPASSWD line on `provision`.
- **HIP submission is local to the bastion**. The user's MFA + portal
  cookies stay in their own browser session; nothing about the user's
  laptop posture is exfiltrated through this proxy.
- **The SSH key is one-shot**. Each `up` rewrites `authorized_keys`
  for the user, so a leaked key from a previous session is invalidated
  the next time the same user authenticates.
- **`/etc/hosts`** is the only laptop-side surface that needs sudo.
  Mapping the corp hostname to `127.0.0.1` is what lets the browser
  validate the cert; without it the popup will show a cert-warning
  fallback URL the user has to click through.

## Why a bastion at all

The original [gpsaml](https://github.com/HerbertChu/gpsaml) Electron
app required every user to:

- Install `openconnect` HEAD (mainline 9.12 segfaults on HIP-enforcing
  GlobalProtect gateways).
- Run an Electron app as root via sudo-prompt.
- Live with a misbehaving `vpnc-script` that needs Wi-Fi toggled after
  disconnect.
- Be on macOS (Apple Silicon).

Centralising the openconnect process on a single Linux VM moves all of
those headaches off the user's laptop and bypasses platform-specific
quirks. The cost is a bastion you have to operate and a SAML middleman
you have to write — both of which this repo provides.

## License

MIT (see `LICENSE`).
