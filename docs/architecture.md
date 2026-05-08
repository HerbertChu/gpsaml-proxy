# Architecture

## End-to-end flow

```
0. one-time per user:
     • install sshuttle (brew install sshuttle / pip install sshuttle)
     • install gpsaml-proxy client (Electron app or CLI)

1. user runs the client
     ├── opens a SAML browser window pointed at the GP portal
     ├── completes Microsoft Entra MFA
     └── client extracts:
           Prelogin-Cookie, Saml-Username
           portal-user-auth-cookie  (via /global-protect/getconfig.esp)
           authcookie               (via /ssl-vpn/login.esp on selected gateway)
           server fingerprint

2. client POSTs the bundle to https://bastion/api/connect

3. bastion (running as root or via narrow sudoers helper):
     ├── verify the SAML username (re-validate the assertion or trust
     │   the client's signed JWT)
     ├── useradd -m -s /usr/sbin/nologin <user>          (idempotent)
     ├── ssh-keygen -t ed25519 -N '' -f /tmp/<rand>      (rotated each login)
     ├── write ~<user>/.ssh/authorized_keys with restrict + ForceCommand
     ├── ip netns add ns_<user>                          (if absent)
     ├── plumb a veth pair, route, NAT into ns_<user>
     ├── ip netns exec ns_<user> openconnect \
     │       --csd-wrapper=hipreport.sh \
     │       --cookie="authcookie=…&user=…&domain=…" \
     │       --servercert <fingerprint> \
     │       <gateway>
     └── return private key + sshuttle command to client

4. client:
     ├── chmod 600 ~/.ssh/gpsaml_proxy_id   (writes received private key)
     └── spawn `sshuttle -r <user>@bastion -e 'ssh -i …' 10.0.0.0/8 --dns`

5. user is now reaching corp services through the bastion's GP tunnel,
   identified individually (per-user openconnect, per-user netns,
   per-user audit trail).

6. disconnect:
     ├── client kills its sshuttle (UI button)
     ├── client POSTs https://bastion/api/disconnect
     └── bastion kills the user's openconnect, tears down ns_<user>,
         rotates the authorized_keys entry off
```

## Why per-user (not shared) GP session

A single shared session is operationally easier but breaks down on
three axes:

- **Compliance**: corporate audit pipelines correlate `user → IP →
  resource access`. With a single shared session every action lands
  under the bastion's IP and a generic service account, undermining
  individual accountability and any SOC alerting that relies on it.
- **HIP enforcement**: GlobalProtect's HIP ("Host Information
  Profile") policy keys off the connecting endpoint. A single
  silhouette can't legitimately represent thirty different endpoints
  each running their own posture; the gateway will quarantine the
  session as soon as Endpoint Protection notices.
- **Throughput / fate-sharing**: one openconnect process bottlenecks
  every user. One stuck rekey, one HIP-triggered disconnect, takes
  everyone down.

Per-user sessions cost more memory (~30 MB / openconnect, plus a
network namespace) but keep the security posture and the failure
domain right.

## Why network namespaces

Each user's openconnect needs its own routing table, its own
`utun*` interface, and its own DNS view. macOS `vpnc-script` already
fights with the system's primary route after every disconnect; doing
that simultaneously for thirty users on the same kernel would be
catastrophic.

Linux net namespaces give each user a private routing realm. SSH'd
sessions for that user are pushed inside the namespace via
`ForceCommand` + `ip netns exec`, so any TCP traffic forwarded by
sshuttle automatically uses the per-user tunnel.

## SAML middleman options

The flow above assumes the client captures the GP authcookie and
hands it to the bastion. We considered (and rejected, for now) doing
the SAML round trip entirely server-side:

- **Pure server-side SAML middleman** — IdP only redirects to ACS
  URLs configured in its app definition, and GP's AuthnRequest is
  signed and pins the GP portal as the SP. Diverting the redirect
  requires either modifying the IdP app config (political cost,
  changes break regular GP usage) or DNS+TLS hijacking the GP portal
  hostname for the user's machine (effectively a MITM, breaks trust
  store).
- **Headless browser on the bastion** — Microsoft Entra MFA cannot be
  driven by a server-side Playwright session without storing user
  passwords + TOTP, which violates AUP and defeats the point of MFA.
- **Browser extension** — works cross-platform without a local
  Electron app, but requires a per-user extension install and is
  harder to package than a regular app.

The "client extracts cookie, posts to bastion" approach is the lowest-
risk and lowest-effort option that keeps SAML/MFA in the user's hands.

## Threat model (selected concerns)

- **Bastion compromise** = every user's GP session is compromised.
  Mitigation: minimise privileges, isolate per-user via netns, restart
  cleanly, log everything to an immutable store.
- **Cloud egress IP** appears as the client to the GP gateway. If the
  gateway has IP allowlists, the bastion's IP must be allowlisted — a
  detail to discuss with corp IT.
- **HIP report** generated by openconnect's `hipreport.sh` will look
  identical for every user because the bastion is one Linux VM. The
  gateway may quarantine on collision detection or on HIP-mismatch
  alerts. This is the most fragile part of the design.
- **SSH key in transit**: the bastion returns a freshly-generated
  private key over HTTPS. The bastion knows the key for milliseconds.
  If even that is unacceptable, switch to the client generating the
  key locally and POSTing the public half (one extra UI step).

## Out of scope (for now)

- High availability of the bastion (HA needs a session store + a way
  to migrate openconnect; deferred until basic flow works).
- Linux / Windows clients (only macOS Electron is wired up; the API
  surface is platform-neutral so adding a Go CLI is mostly transport
  glue).
- Notarised distribution of the client.
- Cost / capacity tuning beyond "fits comfortably on a t3.small".
