#!/bin/bash
# Create / update the Cloudflare A record for the bastion's hostname.
#
# Inputs (env):
#   CLOUDFLARE_API_TOKEN  - scoped token with Zone:DNS:Edit on the
#                           parent zone. Generate at
#                           https://dash.cloudflare.com/profile/api-tokens
#                           with "Edit zone DNS" template, scoped to
#                           your zone.
#   DOMAIN                - full hostname (e.g. gpsaml.lightyearlabs.io)
#   IP                    - target IPv4 (e.g. 192.0.2.42)
#   PROXIED               - "true" to enable Cloudflare proxy (orange
#                           cloud — needs DNS-01 ACME instead, won't
#                           work with Caddy's HTTP-01 default).
#                           Default "false" (DNS-only / grey cloud).
#
# Re-runnable safely. If the record already points at IP it's a no-op.

set -e

API="https://api.cloudflare.com/client/v4"

DOMAIN="${DOMAIN:?set DOMAIN=fqdn}"
IP="${IP:?set IP=a.b.c.d}"
PROXIED="${PROXIED:-false}"

if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
    echo "CLOUDFLARE_API_TOKEN env required (Zone:DNS:Edit on parent)"
    exit 1
fi

# Parse the zone (everything after the first dot, with sanity).
# foo.example.com   -> example.com
# example.com       -> example.com
ZONE="${DOMAIN#*.}"
if [ "$ZONE" = "$DOMAIN" ]; then
    # Single-label fallback — treat the whole thing as the zone.
    ZONE="$DOMAIN"
fi

api() {
    curl -sS \
        -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        -H "Content-Type: application/json" \
        "$@"
}

require_jq() {
    command -v jq >/dev/null 2>&1 || {
        if command -v dnf >/dev/null 2>&1; then sudo dnf install -y jq >/dev/null
        elif command -v apt-get >/dev/null 2>&1; then sudo apt-get install -y jq >/dev/null
        else echo "jq required" >&2; exit 1
        fi
    }
}
require_jq

# 1. Look up the zone ID.
ZONE_ID=$(api "$API/zones?name=$ZONE" | jq -r '.result[0].id // empty')
if [ -z "$ZONE_ID" ]; then
    echo "Cloudflare zone for $ZONE not found (token can't see it, or wrong zone)"
    exit 1
fi
echo "[cloudflare-dns] zone $ZONE -> $ZONE_ID"

# 2. Look up an existing A record for $DOMAIN.
RECORD_JSON=$(api "$API/zones/$ZONE_ID/dns_records?name=$DOMAIN&type=A")
RECORD_ID=$(echo "$RECORD_JSON" | jq -r '.result[0].id // empty')
EXISTING_IP=$(echo "$RECORD_JSON" | jq -r '.result[0].content // empty')
EXISTING_PROXIED=$(echo "$RECORD_JSON" | jq -r '.result[0].proxied // empty')

BODY=$(jq -nc \
    --arg name "$DOMAIN" \
    --arg ip "$IP" \
    --argjson proxied "$PROXIED" \
    '{type:"A",name:$name,content:$ip,ttl:120,proxied:$proxied}')

if [ -z "$RECORD_ID" ]; then
    echo "[cloudflare-dns] creating A $DOMAIN -> $IP (proxied=$PROXIED)"
    api -X POST "$API/zones/$ZONE_ID/dns_records" \
        --data "$BODY" | jq -r '.success, (.errors // [])'
elif [ "$EXISTING_IP" != "$IP" ] || [ "$EXISTING_PROXIED" != "$PROXIED" ]; then
    echo "[cloudflare-dns] updating A $DOMAIN: $EXISTING_IP (proxied=$EXISTING_PROXIED) -> $IP (proxied=$PROXIED)"
    api -X PUT "$API/zones/$ZONE_ID/dns_records/$RECORD_ID" \
        --data "$BODY" | jq -r '.success, (.errors // [])'
else
    echo "[cloudflare-dns] A $DOMAIN -> $IP already correct, no change"
fi

# 3. Wait until the record is live in public DNS (Cloudflare resolvers).
echo "[cloudflare-dns] waiting for DNS propagation…"
for i in $(seq 1 30); do
    RESOLVED=$(dig +short @1.1.1.1 "$DOMAIN" A | head -1)
    if [ "$RESOLVED" = "$IP" ]; then
        echo "[cloudflare-dns] $DOMAIN -> $IP live ($i s)"
        exit 0
    fi
    sleep 2
done
echo "[cloudflare-dns] WARNING: $DOMAIN not yet resolving via 1.1.1.1; Caddy will keep retrying ACME"
