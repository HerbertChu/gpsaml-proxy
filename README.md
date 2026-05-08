# gpsaml-proxy

A self-hosted bastion that runs your GlobalProtect VPN session in the
cloud and exposes it to your laptop over plain SSH.

End users install only **sshuttle**. No `openconnect`, no Hardened Runtime
fights, no per-laptop sudo prompts, no Mac-only Electron app.

## Status

⚠️ **Pre-PoC.** Architecture is sketched, none of the validation gates have
been cleared yet. Don't deploy. Don't depend on it.

The required milestones to confirm the design is even feasible are tracked
in [`docs/poc-checklist.md`](docs/poc-checklist.md). The first one — does
the cloud VM you intend to host the bastion on reach the GlobalProtect
portal at all? — is the most likely place this idea dies.

## Architecture

```
┌─────────────┐  1. SAML in browser   ┌───────────────────┐
│   Laptop    │──────────────────────▶│  GP Portal + IdP  │
│  (gpsaml-   │  2. authcookie        └─────────┬─────────┘
│   proxy     │◀─────────────────────────────────┘
│   client)   │
│             │  3. POST authcookie    ┌──────────────────┐
│             │──────────────────────▶│   Bastion (this) │
│             │                       │                  │
│             │  4. private SSH key   │  • SAML SP       │
│             │◀──────────────────────│  • per-user      │
│             │                       │    netns         │
│             │                       │  • per-user      │
│             │  5. sshuttle SSH      │    openconnect   │
│             │◀═════════════════════▶│                  │
└─────────────┘                       └────────┬─────────┘
                                              │
                                      6. IPsec tunnel
                                              ▼
                                       ┌──────────────┐
                                       │ Corp network │
                                       └──────────────┘
```

The user-facing surface is one button on a small Electron client (or a
web page) and one `sshuttle` command. Everything else lives on the
bastion.

## Why a bastion at all

The original [gpsaml](https://github.com/HerbertChu/gpsaml) Electron app
requires every user to:

- Install `openconnect` HEAD (mainline 9.12 segfaults on HIP-enforcing
  GlobalProtect gateways).
- Run an Electron app as root via sudo-prompt.
- Live with a misbehaving `vpnc-script` that needs Wi-Fi toggled after
  disconnect.
- Be on macOS (Apple Silicon).

Centralising the openconnect process on a single Linux VM moves all of
those headaches off the user's laptop and bypasses platform-specific
quirks. The cost is a bastion you have to operate and a SAML middleman
you have to write.

## Components

| Path | Purpose |
| --- | --- |
| `docs/` | Design notes, PoC checklist, deployment runbook (TBD) |
| `poc/` | Throwaway scripts that validate one feasibility question each |
| `bastion/` | The HTTP API + per-user netns + openconnect orchestrator |
| `client/` | Either a thin patch on top of gpsaml or a stand-alone CLI |

## PoC plan

Each step must succeed before the next one is worth attempting.

1. **Reachability** — a cloud Linux VM can hit `portal/global-protect/prelogin.esp`
   without being firewalled / IP-blocked. (`poc/01-cloud-reachability.sh`)
2. **HIP** — `openconnect --HEAD --csd-wrapper=hipreport.sh` from that
   VM successfully establishes a tunnel using a cookie obtained from a
   real laptop run of gpsaml.
3. **Network namespace isolation** — a second openconnect session in a
   separate netns coexists with the first without route conflicts.
4. **sshuttle relay** — a developer laptop pinning `sshuttle` against the
   bastion via SSH can reach corp services through the bastion's tunnel.
5. **End-to-end automation** — the SAML middleman drives 1–4 from the
   browser without manual cookie copy-paste.

If step 1 fails the project ends, no harm done.

## License

MIT (see `LICENSE`).
