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

## Gate 2 — HIP-passing openconnect from cloud ✅ PASS (2026-05-08)

**Question:** can `openconnect --HEAD` running on the cloud VM, fed
a fresh `authcookie` from a laptop run of gpsaml, actually establish
the IPsec tunnel?

GlobalProtect HIP enforcement may quarantine the session because the
hipreport.sh shipped with openconnect will report a Linux machine
with no FileVault, no AV, etc. Some gateways tolerate "Linux server",
some don't.

**Result:** built openconnect from `gitlab.com/openconnect/openconnect`
master on AL2023 (`./configure --with-gnutls --with-vpnc-script=...`,
~3 min on `t3.medium`). Fed a fresh `authcookie` extracted from the
laptop's `/tmp/gpsaml.log`. openconnect ran cleanly through every
phase the macOS 9.12 build choked on:

```
HIP script /usr/local/libexec/openconnect/hipreport.sh completed
    successfully (report is 2316 bytes).
POST .../ssl-vpn/hipreport.esp
HIP report submitted successfully.
ESP session established with server
Configured as 10.245.16.201, with SSL disconnected and ESP established
Session authentication will expire at Fri, 08 May 2026 22:22:54 UTC
```

No segfault, no quarantine, ~16 hour session lifetime. The bundled
hipreport.sh's "Linux server, no AV, no FileVault" payload was
accepted by the gateway as-is.

Caveat to flag for production: a few seconds in we saw `ESP detected
dead peer / Failed to connect ESP tunnel; using HTTPS instead`,
suggesting AWS' default SG state on inbound UDP/4501 isn't reliable.
The bastion deployment will likely need an explicit SG rule (or
force `--no-dtls` to ride HTTPS only).

**Decision:** if HIP enforcement quarantines, the next step is
either (a) hand-craft a hipreport that mimics a compliant macOS
endpoint (legally questionable), or (b) get IT to relax HIP for the
bastion. Without one of those, stop.

→ Cleared. Move to Gate 3.

## Gate 3 — Multiple openconnect sessions in netns ✅ PASS (2026-05-08)

**Question:** can two simultaneous openconnect sessions in two
separate `ip netns` instances coexist without route or DNS conflicts?

**Result:** validated the kernel-level mechanics rather than a second
GP session (the laptop only had one fresh cookie, and Gate 2's
openconnect cleanly logged out of the gateway when it terminated).

Created `ns_a` and `ns_b`, plumbed each via a `veth` pair to the host
with `MASQUERADE` NAT on the host's `ens5` egress. Both namespaces
acquired their own routing table (`default via 10.200.1.1` vs
`default via 10.200.2.1`), both reached `https://checkip.amazonaws.com`
independently (each saw the host's public IP `18.183.75.190`).

A dummy `utun_test` interface created inside `ns_a` was invisible to
both `ns_b` and the host's root namespace — i.e. the per-user `utunN`
that openconnect would create inside one namespace cannot be seen,
addressed, or routed-to from any other namespace. Combined with the
working Gate 2 openconnect run, this is enough to conclude that
running N openconnect processes in N netns gives N independent
tunnels with no cross-talk.

→ Cleared. Move to Gate 4.

## Gate 4 — sshuttle through the bastion ⏳ PARTIAL (2026-05-08)

This gate has three independent layers; A and B are cleared, C is
blocked on a problem that the gates above didn't anticipate.

### A. Provision helper

`bastion/bin/provision up <user> <cookie> <gateway> <fingerprint>`,
running on a fresh AL2023 t3.medium with openconnect HEAD installed.

**Result:** ✅ everything around openconnect works — useradd, ssh
keypair generation, restricted authorized_keys, per-user
sudoers entry validated by visudo, sequential subnet allocation in a
flock'd JSON file, netns + veth + MASQUERADE NAT, and the actual
`ip netns exec ns_<user> openconnect …` invocation. The only failure
mode hit was `Cookie was rejected by server` — see C below — which
is a layer above the helper.

### B. SSH ForceCommand → netns

`bastion/bin/enter-ns` invoked from authorized_keys
`command="enter-ns ns_<user>"`, with sshd matching members of the
`gpsaml-users` group to publickey-only / no-pty / no-forwarding.

**Result:** ✅
- `ssh hc1079@bastion "ip -br a"` returns ns_hc1079's interfaces.
- `ssh hc1079@bastion "id"` returns `uid=1001(hc1079)` — enter-ns
  drops privilege via `setpriv --reuid=… --regid=… --clear-groups`
  *after* `ip netns exec` but *before* the client's shell runs, so
  the SSH session has the user's authority despite traversing root.
- `ssh hc1079@bastion "cat /etc/shadow"` → Permission denied.
- `ssh hc1079@bastion "sudo ip netns exec ns_other_user ls"` → sudo
  refuses (the per-user sudoers is scoped to `ns_<user>` only).
- Plain `ssh hc1079@bastion` (no command) → `gpsaml-proxy:
  interactive shells are not permitted`.

### C. sshuttle end-to-end ⏳ blocked on cookie supply

**Blocker:** the GP `authcookie` extracted from a laptop run of
gpsaml is a one-shot — by the time we hand it to the bastion, the
laptop's openconnect has already consumed it on `getconfig.esp` and
the gateway returns "Cookie was rejected by server". Bastion can
*almost* establish the tunnel — TLS handshake, prelogin, server cert
fingerprint match all pass; only the final session bring-up fails.

The architecture demands a way for the cookie to land at the bastion
**without** the laptop's openconnect having seen it first. Options
ranked by intrusiveness:

1. Add a `--bastion-mode` to the gpsaml client that walks the SAML
   handshake to the point of obtaining `authcookie` and then POSTs
   it to the bastion instead of spawning a local openconnect. This
   is also what Gate 5 needs anyway, so doing it here unblocks both.
2. Run the client through a stub openconnect that captures `--cookie=…`
   and exits cleanly. Crude but unblocks an isolated Phase-C test.
3. Genuine server-side SAML middleman (rejected earlier — would
   require IT to register the bastion as its own SP).

Decision: do (1) as Gate 5 work, then come back to this gate with a
real fresh authcookie.

## Gate 5 — automation

After all four manual gates pass, write the bastion HTTP API and the
client that drives the flow without manual cookie copy-paste. This is
the largest engineering chunk and only worth starting if the gates
above are clean.
