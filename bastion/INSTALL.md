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
