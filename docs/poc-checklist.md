# PoC checklist

Each gate must clear before the next one is worth building. If gate 1
fails the project is dead — abandon it cheerfully.

## Gate 1 — Cloud reachability ✅ PASS (2026-05-08)

**Question:** can a generic public-cloud Linux VM reach the
GlobalProtect portal at all?

Many corporate GP gateways have IP allowlists, geofences, or
deployment-specific firewalls that reject anything that isn't a
real employee laptop on a residential ISP.

**How to test:** `poc/01-cloud-reachability.sh` from any cloud VM.
Pass / fail criteria are in the script.

**Result:** ran from a `t3.nano` in `ap-northeast-1` (egress IP
`13.114.137.91`, Tokyo) hitting `vpn.vistancenetworks.com`. The
portal answered `HTTP 200` with a fully-formed `<prelogin-response>`
including a fresh `<saml-request>` and `<region>JP</region>`. No IP
allowlist, no geofence rejecting non-corp egress; the SAML challenge
shape is identical to the one a laptop run of gpsaml receives.

**Decision:** if the prelogin endpoint refuses TLS, returns 4xx, or
returns an XML error, stop. The bastion design is unworkable without
IT support to whitelist the bastion's egress IP.

→ Cleared. Move to Gate 2.

## Gate 2 — HIP-passing openconnect from cloud

**Question:** can `openconnect --HEAD` running on the cloud VM, fed
a fresh `authcookie` from a laptop run of gpsaml, actually establish
the IPsec tunnel?

GlobalProtect HIP enforcement may quarantine the session because the
hipreport.sh shipped with openconnect will report a Linux machine
with no FileVault, no AV, etc. Some gateways tolerate "Linux server",
some don't.

**How to test:** TBD — `poc/02-tunnel-from-cloud.sh`.

**Decision:** if HIP enforcement quarantines, the next step is
either (a) hand-craft a hipreport that mimics a compliant macOS
endpoint (legally questionable), or (b) get IT to relax HIP for the
bastion. Without one of those, stop.

## Gate 3 — Multiple openconnect sessions in netns

**Question:** can two simultaneous openconnect sessions in two
separate `ip netns` instances coexist without route or DNS conflicts?

**How to test:** TBD — `poc/03-netns-coexist.sh`.

**Decision:** netns isolation either works cleanly or it doesn't. If
some kernel-level sharing surfaces (likely around DNS via systemd-
resolved, or scutil-equivalent state), we'll need to either run the
bastion on a kernel without that interference or fall back to
container-per-user.

## Gate 4 — sshuttle through the bastion

**Question:** does a developer laptop running `sshuttle -r
user@bastion 10.0.0.0/8 --dns` actually reach corp services through
the bastion's tunnel?

**How to test:** TBD — `poc/04-sshuttle-end-to-end.md`.

**Decision:** if MTU / encapsulation issues bite, we'll have to
choose between teaching the docs to set --max-mtu, switching to a
WireGuard sidecar, or accepting the workaround.

## Gate 5 — automation

After all four manual gates pass, write the bastion HTTP API and the
client that drives the flow without manual cookie copy-paste. This is
the largest engineering chunk and only worth starting if the gates
above are clean.
