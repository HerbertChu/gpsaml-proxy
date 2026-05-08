#!/usr/bin/env bash
# Gate 1: can a cloud Linux VM reach the GlobalProtect portal?
#
# Usage:
#   PORTAL=vpn.example.com ./01-cloud-reachability.sh
#
# Run this on the cloud VM you intend to host the bastion on, NOT on
# your laptop. The whole point is to find out whether the cloud egress
# IP gets through.
#
# Exit codes:
#   0  — prelogin returned an XML <prelogin-response> document, the
#         portal is reachable, the bastion design is feasible at the
#         network layer.
#   1  — TLS / HTTP / DNS failure. Probably an IP allowlist on the
#         portal, an upstream firewall, or you typo'd PORTAL.
#   2  — got an HTTP response but it isn't a prelogin XML payload.
#         Inspect the body manually.

set -euo pipefail

if [[ -z "${PORTAL:-}" ]]; then
  echo "Set PORTAL=<your portal hostname> first." >&2
  echo "Example:  PORTAL=vpn.example.com $0" >&2
  exit 1
fi

URL="https://${PORTAL}/global-protect/prelogin.esp?tmp=tmp&kerberos-support=yes&ipv6-support=yes&clientVer=4100&clientos=Linux"

echo "==> POSTing prelogin to ${URL}"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

HTTP_STATUS=$(curl -sS -o "$TMP" -w "%{http_code}" \
  -A "PAN GlobalProtect" \
  -X POST \
  --max-time 15 \
  "$URL" 2>&1) || {
  echo "FAIL: curl could not complete the request." >&2
  echo "      Most likely: TLS rejection, DNS failure, or IP block." >&2
  echo "Output:" >&2
  cat "$TMP" >&2 || true
  exit 1
}

echo "==> HTTP status: $HTTP_STATUS"

if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "FAIL: portal answered with non-200 status ($HTTP_STATUS)." >&2
  echo "Body:" >&2
  cat "$TMP" >&2
  exit 1
fi

if ! grep -q '<prelogin-response>' "$TMP"; then
  echo "FAIL: 200 OK but no <prelogin-response> tag in body." >&2
  echo "Body:" >&2
  cat "$TMP" >&2
  exit 2
fi

echo "==> Body looks like a real prelogin response. Excerpt:"
grep -E '<status>|<saml-auth-method>|<saml-default-browser>|<panos-version>' "$TMP" || true

echo
echo "PASS: gate 1 cleared. The cloud VM can reach the portal."
echo "Next: get a fresh authcookie from a laptop run of gpsaml and"
echo "      try openconnect --HEAD from this VM (gate 2)."
