# Bastion install — Phase A

This document covers just enough to test the privileged provisioning helper
manually. SSH integration, the web service, and the SAML middleman are
deferred to later phases (see `docs/poc-checklist.md`).

Tested on Amazon Linux 2023 (kernel 6.12, x86_64).

## Prerequisites on the bastion VM

```sh
dnf install -y -q git iptables iproute python3 \
  gcc make autoconf automake libtool gettext gettext-devel pkgconfig \
  openssl-devel libxml2-devel zlib-devel gnutls-devel kernel-headers

# vpnc-script (standard reference implementation)
mkdir -p /etc/vpnc
curl -fsSL -o /etc/vpnc/vpnc-script \
  https://gitlab.com/openconnect/vpnc-scripts/-/raw/master/vpnc-script
chmod +x /etc/vpnc/vpnc-script

# openconnect from upstream master (mainline 9.12 has a HIP segfault)
git clone --depth 1 https://gitlab.com/openconnect/openconnect.git /tmp/openconnect
cd /tmp/openconnect
./autogen.sh
./configure --prefix=/usr/local --with-gnutls \
            --with-vpnc-script=/etc/vpnc/vpnc-script
make -j"$(nproc)"
make install
/usr/local/sbin/openconnect --version | head -3
```

## Drop the helper in place

```sh
install -d -m 755 /opt/gpsaml-proxy/bin
install -m 750 -o root -g root \
  bastion/bin/provision           /opt/gpsaml-proxy/bin/
install -m 755 -o root -g root \
  bastion/bin/vpnc-script-netns   /opt/gpsaml-proxy/bin/

install -d -m 750 -o root -g root /var/lib/gpsaml-proxy
install -d -m 750 -o root -g root /var/run/gpsaml-proxy
install -d -m 750 -o root -g root /var/log/gpsaml-proxy
```

## Manual smoke test

1. Capture a fresh GP `authcookie` on a working laptop run of gpsaml:

   ```sh
   sudo grep "Spawning openconnect" /tmp/gpsaml.log | tail -1
   ```

   The `--cookie=…`, `--servercert …`, and final hostname argument from
   that line are everything `provision up` needs.

2. On the bastion, as root:

   ```sh
   /opt/gpsaml-proxy/bin/provision up alice \
       'authcookie=...&portal=...&user=alice&domain=...&...' \
       taiwan-vpn.example.com \
       E311340EE7F798CAA59FA2ED30CE7377CCC64D19 \
     | tee /tmp/alice-key.pem
   ```

   Expected: `~15 s`, the alice-key.pem file contains a fresh
   `BEGIN OPENSSH PRIVATE KEY` block.

3. Verify the tunnel is up inside `ns_alice`:

   ```sh
   ip netns exec ns_alice ip -br a
   ip netns exec ns_alice ip route
   cat /etc/netns/ns_alice/resolv.conf
   ```

   You should see a `tun0` (or `utun0`) with a `10.x.x.x` address and a
   default route via that interface, plus a resolv.conf pointing at the
   internal DNS server pushed by the gateway.

4. Exercise corp DNS via the per-netns resolver:

   ```sh
   ip netns exec ns_alice getent hosts internal-host.corp.example
   ```

5. Tear down:

   ```sh
   /opt/gpsaml-proxy/bin/provision down alice
   ip netns list                       # ns_alice should be gone
   pgrep -af openconnect               # nothing
   cat /etc/netns/ns_alice/resolv.conf 2>/dev/null  # gone
   ls -la /etc/sudoers.d/gpsaml-user-alice 2>/dev/null  # gone
   ```

If every step lands cleanly, Phase A is good. The next phase is
hooking sshd's `ForceCommand` to the per-user namespace via
`/opt/gpsaml-proxy/bin/enter-ns` and validating sshuttle end-to-end.

## Phase B — sshd ForceCommand

```sh
install -m 755 -o root -g root \
  bastion/bin/enter-ns                          /opt/gpsaml-proxy/bin/

install -m 644 -o root -g root \
  bastion/etc/sshd_config-gpsaml.conf           /etc/ssh/sshd_config.d/99-gpsaml.conf

systemctl reload sshd
```

After `provision up` has put a user (and their authorized_keys + sudoers
entry) on the host, you can validate the SSH integration loopback-style
without poking holes in the bastion's security group:

```sh
# Generate a throwaway local key and overwrite hc1079's authorized_keys
# so we can SSH in from the bastion itself.
mkdir -p /tmp/test-key && ssh-keygen -t ed25519 -N '' -f /tmp/test-key/id -C test
cat > /home/hc1079/.ssh/authorized_keys <<EOF
restrict,permitopen="*:*",no-pty,no-agent-forwarding,no-X11-forwarding,no-user-rc,command="/opt/gpsaml-proxy/bin/enter-ns ns_hc1079" $(cat /tmp/test-key/id.pub)
EOF
chown hc1079:gpsaml-users /home/hc1079/.ssh/authorized_keys

# Run a command — should land inside ns_hc1079.
ssh -i /tmp/test-key/id -o StrictHostKeyChecking=no hc1079@localhost "ip -br a"

# Asking for nothing (interactive shell) — should be refused by enter-ns.
ssh -i /tmp/test-key/id -o StrictHostKeyChecking=no hc1079@localhost
```

The first command should print the namespace's `lo` and `vp_<user>`
interfaces (and `tun0` once a tunnel is up). The second should return
`gpsaml-proxy: interactive shells are not permitted`.

## Phase 5a — Web / API service

```sh
# unprivileged service account
useradd -r -s /usr/sbin/nologin -d /opt/gpsaml-proxy/web -M gpw

# install web app
install -d -m 755 /opt/gpsaml-proxy/web
install -m 644 -o root -g root \
  bastion/web/app.py            /opt/gpsaml-proxy/web/
install -m 644 -o root -g root \
  bastion/web/requirements.txt  /opt/gpsaml-proxy/web/

# Python venv (avoid polluting system pip)
python3 -m venv /opt/gpsaml-proxy/venv
/opt/gpsaml-proxy/venv/bin/pip install -r /opt/gpsaml-proxy/web/requirements.txt

# shared HMAC secret (rotate on rebuild)
install -d -m 750 -o gpw -g gpw /etc/gpsaml-proxy
head -c 32 /dev/urandom | base64 > /etc/gpsaml-proxy/secret
chown gpw:gpw /etc/gpsaml-proxy/secret
chmod 0400 /etc/gpsaml-proxy/secret

# logs
install -d -m 750 -o gpw -g gpw /var/log/gpsaml-proxy

# sudoers entry for gpw → provision
install -m 0440 -o root -g root \
  bastion/etc/sudoers-web.conf  /etc/sudoers.d/gpsaml-proxy-web
visudo -cf /etc/sudoers.d/gpsaml-proxy-web

# systemd unit
install -m 644 -o root -g root \
  bastion/systemd/gpsaml-proxy-web.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now gpsaml-proxy-web

# sanity
curl -fsS http://127.0.0.1:8080/healthz
```

A signed test against the API (auth-only, expects to fail at the
provision call because we have no real cookie):

```sh
SECRET=$(cat /etc/gpsaml-proxy/secret)
BODY='{"username":"hc1079","authcookie":"x","gateway":"vpn.example.com","fingerprint":"AA"}'
SIG=$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
curl -sS -X POST -H "Content-Type: application/json" \
  -H "X-GPSAML-Signature: $SIG" \
  -d "$BODY" http://127.0.0.1:8080/api/connect
# expected: 500 / "provision failed" because the cookie is bogus —
# but the HMAC check passed and the helper *was* invoked.
```
