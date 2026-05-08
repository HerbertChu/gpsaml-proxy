/**
 * Static config — defaults for a fresh extension install.
 *
 * Anything corp-specific (your portal hostname, bastion URL, shared
 * secret, gateway fingerprint, default forwards) should be set in
 * the popup UI or via chrome.storage.local; the values below are
 * placeholders so this file can ship as part of the public repo
 * without leaking deployment specifics.
 *
 * To customize for your own deployment, fork the repo and edit this
 * file (or wire a proper options page to chrome.storage.local).
 */
export const PORTAL = "vpn.example.com";
export const GATEWAY = "vpn.example.com";

// SHA-1 fingerprint of your GP gateway's TLS cert. Browser fetch
// can't read it, openconnect needs it via --servercert. Pull it once:
//   openssl s_client -connect <gw>:443 </dev/null \
//     | openssl x509 -fingerprint -sha1 -noout
// then strip the colons.
export const GATEWAY_FINGERPRINT = "0000000000000000000000000000000000000000";

// URL of your gpsaml-proxy bastion. Must match the Caddyfile site
// block + DNS A record. Use https in production.
export const BASTION = "https://gpsaml.example.com";

// Shared with the bastion's /etc/gpsaml-proxy/secret. Generate with:
//   head -c 32 /dev/urandom | base64
// Both ends must hold the same value; the extension HMAC-signs every
// /api/connect body and the bastion verifies. Leaving this empty is
// fine for a dev fork (bastion will reject signatures), but you will
// have to set the same value in both places before traffic flows.
export const BASTION_SECRET = "";

// Default L4 forwards. Each entry produces an `ip netns exec
// socat TCP-LISTEN:<port> TCP:<resolved-ip>:<port>` on the bastion
// inside the user's netns, and a corresponding `ssh -L
// <port>:<netns-ip>:<port>` from the laptop to the bastion. With
// /etc/hosts redirecting `<hostname> -> 127.0.0.1`, the user types
// the corp URL unchanged.
//
// Replace these with whatever internal services you want one-shot
// access to (web UIs, git SSH, internal APIs). The popup UI lets
// individual users add / remove on top of these.
export const DEFAULT_FORWARDS = [
  { hostname: "git.example.com", port: 443, label: "Git Web (HTTPS)" },
  { hostname: "git.example.com", port: 7999, label: "Git over SSH" },
];
