#!/bin/bash
# Deploy gpsaml-proxy bastion. Idempotent — re-runnable safely.
#
# What it does, in order:
#   - Installs socat, caddy (only if missing).
#   - Drops latest provision / app.py / extension into /opt/gpsaml-proxy.
#   - Drops Caddyfile into /etc/caddy (replacing).
#   - systemd reload + restart of gpsaml-proxy-web and caddy.
#
# Run as a user with passwordless sudo (e.g. ubuntu / ec2-user).

set -e

REPO="${REPO:-/opt/gpsaml-proxy}"
DOMAIN="${DOMAIN:-gpsaml.lightyearlabs.io}"
# Repo root: ../.. from this script (which lives at bastion/bin/deploy.sh).
SRC="${SRC:-$(cd "$(dirname "$0")/../.." && pwd)}"

echo "=== gpsaml-proxy deploy ==="
echo "  REPO=$REPO  DOMAIN=$DOMAIN"
echo "  SRC=$SRC"

# ── packages ──────────────────────────────────────────────────────
need_install() { ! command -v "$1" >/dev/null 2>&1; }

# socat — used by provision to spawn netns-internal L4 forwarders.
if need_install socat; then
    if command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y socat
    elif command -v apt-get >/dev/null 2>&1; then
        sudo apt-get update -qq && sudo apt-get install -y socat
    fi
fi

# caddy binary — the AL2023 / Debian package paths differ; we always
# install the official static binary so the script is OS-agnostic.
if need_install caddy; then
    curl -sSL "https://caddyserver.com/api/download?os=linux&arch=amd64" \
        -o /tmp/caddy
    sudo install -m 0755 /tmp/caddy /usr/local/bin/caddy
fi

# caddy user / dirs / unit — idempotent. Always run these so a re-
# deploy after an aborted install completes the picture.
id caddy >/dev/null 2>&1 || sudo useradd --system --home-dir /var/lib/caddy \
    --shell /sbin/nologin --create-home caddy
sudo install -d -o caddy -g caddy /var/lib/caddy /var/log/caddy
sudo tee /etc/systemd/system/caddy.service >/dev/null <<'UNIT'
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
Restart=on-failure
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload

# ── files ─────────────────────────────────────────────────────────
sudo install -d -o gpw -g gpw "$REPO/web" "$REPO/static" "$REPO/bin" "$REPO/extension"
sudo install -d /var/log/gpsaml-proxy /var/log/caddy /etc/gpsaml-proxy /etc/caddy

# Bastion code.
sudo install -m 0755 "$SRC/bastion/bin/provision"            "$REPO/bin/provision"
sudo install -m 0755 "$SRC/bastion/bin/vpnc-script-netns"    "$REPO/bin/vpnc-script-netns"
sudo install -m 0755 "$SRC/bastion/bin/enter-ns"             "$REPO/bin/enter-ns"
sudo install -m 0644 "$SRC/bastion/web/app.py"               "$REPO/web/app.py"
sudo install -m 0644 "$SRC/bastion/static/index.html"        "$REPO/static/index.html"

# Optional /etc/gpsaml-proxy/forwards.json — only used as fallback
# when the extension doesn't send forwards in the request body.
if [ -f "$SRC/bastion/etc/forwards.json" ]; then
    sudo install -m 0644 "$SRC/bastion/etc/forwards.json" \
        /etc/gpsaml-proxy/forwards.json
fi

# Extension source — served as zip on demand by /download/extension.zip.
sudo cp -r "$SRC/extension/." "$REPO/extension/"

# Caddyfile.
sudo install -m 0644 "$SRC/bastion/etc/Caddyfile" /etc/caddy/Caddyfile

# Sudoers: gpw can run provision.
sudo install -m 0440 -o root -g root "$SRC/bastion/etc/sudoers-web.conf" \
    /etc/sudoers.d/gpsaml-proxy-web

# systemd unit.
sudo install -m 0644 "$SRC/bastion/systemd/gpsaml-proxy-web.service" \
    /etc/systemd/system/gpsaml-proxy-web.service
sudo systemctl daemon-reload

# ── secret ────────────────────────────────────────────────────────
if [ ! -f /etc/gpsaml-proxy/secret ]; then
    head -c 32 /dev/urandom | base64 | sudo tee /etc/gpsaml-proxy/secret >/dev/null
    sudo chown gpw:gpw /etc/gpsaml-proxy/secret
    sudo chmod 0640 /etc/gpsaml-proxy/secret
    echo "[deploy] generated new bastion secret at /etc/gpsaml-proxy/secret"
fi

# ── services ──────────────────────────────────────────────────────
sudo systemctl enable --now gpsaml-proxy-web
sudo systemctl restart gpsaml-proxy-web
sudo systemctl enable --now caddy
sudo systemctl reload caddy || sudo systemctl restart caddy

# ── DNS (via Cloudflare API) ──────────────────────────────────────
# Token is loaded from AWS Secrets Manager by default (the bastion's
# instance role needs secretsmanager:GetSecretValue on
# gpsaml/cloudflare-api-token-*). Set CLOUDFLARE_API_TOKEN in env
# to skip the SM call (e.g. when running from outside AWS).
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && command -v aws >/dev/null 2>&1; then
    CLOUDFLARE_API_TOKEN=$(aws secretsmanager get-secret-value \
        --secret-id gpsaml/cloudflare-api-token \
        --query SecretString --output text 2>/dev/null || true)
fi

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    PUBLIC_IP="${PUBLIC_IP:-$(curl -sS https://checkip.amazonaws.com)}"
    echo
    echo "=== Cloudflare A record ==="
    DOMAIN="$DOMAIN" IP="$PUBLIC_IP" PROXIED="${PROXIED:-false}" \
        CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
        bash "$SRC/bastion/bin/cloudflare-dns.sh" || \
        echo "[deploy] cloudflare-dns.sh failed (set DNS manually if needed)"
    # Nudge Caddy to retry ACME now that DNS is live.
    sudo systemctl reload caddy || true
else
    echo "[deploy] no CLOUDFLARE_API_TOKEN; set the A record yourself"
fi

echo
echo "=== deploy done ==="
echo "Status:"
sudo systemctl is-active gpsaml-proxy-web caddy || true
echo
echo "DNS check:"
getent hosts "$DOMAIN" || echo "  WARNING: $DOMAIN doesn't resolve — set the A record!"
echo
echo "Healthz:"
curl -sS "https://$DOMAIN/healthz" 2>/dev/null || \
    curl -sS "http://127.0.0.1:8080/healthz"
