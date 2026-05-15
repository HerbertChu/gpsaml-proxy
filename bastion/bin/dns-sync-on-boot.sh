#!/bin/bash
# Auto-sync Cloudflare A record on boot.
#
# Pulls the Cloudflare API token from AWS Secrets Manager (the bastion
# instance role must have secretsmanager:GetSecretValue on
# gpsaml/cloudflare-api-token), grabs the current public IP, and runs
# cloudflare-dns.sh. Used by gpsaml-dns-sync.service so an EIP swap or
# fresh boot quietly re-points DNS without a manual deploy.
#
# Inputs (env, all optional with defaults):
#   DOMAIN   - hostname to pin (default gpsaml.lightyearlabs.io)
#   SM_ID    - AWS SM secret id (default gpsaml/cloudflare-api-token)

set -e

DOMAIN="${DOMAIN:-gpsaml.lightyearlabs.io}"
SM_ID="${SM_ID:-gpsaml/cloudflare-api-token}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

log() { echo "[$(date -u +%FT%TZ) dns-sync-on-boot] $*"; }

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    CLOUDFLARE_API_TOKEN=$(aws secretsmanager get-secret-value \
        --secret-id "$SM_ID" --query SecretString --output text 2>/dev/null || true)
fi
if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
    log "no CLOUDFLARE_API_TOKEN (SM id=$SM_ID) — skipping"
    exit 0
fi

PUBLIC_IP=$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')
if [ -z "$PUBLIC_IP" ]; then
    log "couldn't determine public IP — skipping"
    exit 0
fi

log "syncing $DOMAIN -> $PUBLIC_IP"
DOMAIN="$DOMAIN" IP="$PUBLIC_IP" PROXIED="${PROXIED:-false}" \
    CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
    bash "$SCRIPT_DIR/cloudflare-dns.sh"
