"""
gpsaml-proxy web / API.

Lives between the SAML-aware gpsaml client (laptop side, Electron) and
the privileged provision helper. Validates HMAC-signed requests, calls
out to `sudo provision …`, and hands the freshly-issued SSH key back to
the client. The web process itself runs unprivileged (as the `gpw`
user); the only thing it can do as root is execute provision via a
NOPASSWD sudoers entry.
"""

import hashlib
import hmac
import os
import pathlib
import re
import subprocess

from flask import Flask, jsonify, request, send_from_directory

# ── config ──────────────────────────────────────────────────────────
PROVISION = "/opt/gpsaml-proxy/bin/provision"
USERNAME_RE = re.compile(r"^[a-z][a-z0-9_-]{1,30}$")
SECRET_PATH = pathlib.Path(
    os.environ.get("GPSAML_PROXY_SECRET", "/etc/gpsaml-proxy/secret")
)
STATIC_DIR = pathlib.Path(__file__).resolve().parent.parent / "static"

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")


# ── auth ────────────────────────────────────────────────────────────
def _shared_secret() -> bytes:
    if not SECRET_PATH.exists():
        raise FileNotFoundError(
            f"missing shared secret at {SECRET_PATH}; "
            "create it with `head -c 32 /dev/urandom | base64 > {path}`"
        )
    return SECRET_PATH.read_bytes().strip()


def verify_hmac():
    """Reject the request if the X-GPSAML-Signature header doesn't match
    HMAC-SHA256(shared_secret, request_body). Constant-time compared."""
    sig = request.headers.get("X-GPSAML-Signature", "")
    body = request.get_data()
    expected = hmac.new(_shared_secret(), body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        raise PermissionError("bad signature")


# ── helper invocation ──────────────────────────────────────────────
def call_provision(*args: str) -> subprocess.CompletedProcess:
    # 60s isn't enough: a "warm reconnect" calls cmd_down (which can
    # take ~10s waiting for the previous openconnect to drop) and then
    # cmd_up (~30s for HIP + auth + tunnel-up poll). Budget 3 min.
    return subprocess.run(
        ["sudo", "-n", PROVISION, *args],
        capture_output=True,
        text=True,
        timeout=180,
    )


# ── routes ──────────────────────────────────────────────────────────
@app.get("/")
def landing():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.post("/api/connect")
def connect():
    try:
        verify_hmac()
    except (PermissionError, FileNotFoundError) as e:
        return jsonify({"error": str(e)}), 403

    payload = request.get_json(silent=True) or {}
    user = payload.get("username", "")
    cookie = payload.get("authcookie", "")
    gateway = payload.get("gateway", "")
    fingerprint = payload.get("fingerprint", "")

    if not USERNAME_RE.match(user):
        return jsonify({"error": f"bad username: {user!r}"}), 400
    if not all([cookie, gateway, fingerprint]):
        return jsonify({"error": "missing authcookie, gateway, or fingerprint"}), 400

    res = call_provision("up", user, cookie, gateway, fingerprint)
    if res.returncode == 3:
        return jsonify({"error": "bastion at capacity"}), 503
    if res.returncode != 0:
        # Stash the full stderr so SSM-only debugging is possible even
        # when the client truncates the response body.
        try:
            log_path = pathlib.Path("/var/log/gpsaml-proxy/provision.log")
            with log_path.open("a") as fh:
                fh.write(
                    f"\n===== {user} {os.environ.get('HOSTNAME', '?')} "
                    f"rc={res.returncode} =====\n"
                )
                fh.write(res.stderr)
                fh.write("\n----- stdout -----\n")
                fh.write(res.stdout)
                fh.write("\n")
        except Exception:
            pass
        return (
            jsonify({"error": "provision failed", "detail": res.stderr.strip()[:4000]}),
            500,
        )

    private_key = res.stdout
    bastion_host = request.host.split(":")[0]
    return jsonify(
        {
            "private_key": private_key,
            "ssh_user": user,
            "ssh_host": bastion_host,
            "sshuttle_command": (
                f"sshuttle -r {user}@{bastion_host} "
                f"-e 'ssh -i ~/.ssh/gpsaml_proxy_id' "
                "10.0.0.0/8 172.16.0.0/12 --dns"
            ),
        }
    )


@app.post("/api/disconnect")
def disconnect():
    try:
        verify_hmac()
    except (PermissionError, FileNotFoundError) as e:
        return jsonify({"error": str(e)}), 403

    payload = request.get_json(silent=True) or {}
    user = payload.get("username", "")
    if not USERNAME_RE.match(user):
        return jsonify({"error": "bad username"}), 400

    res = call_provision("down", user)
    if res.returncode != 0:
        return (
            jsonify({"error": "down failed", "detail": res.stderr.strip()[:1000]}),
            500,
        )
    return jsonify({"ok": True})


@app.post("/api/heartbeat")
def heartbeat():
    try:
        verify_hmac()
    except (PermissionError, FileNotFoundError) as e:
        return jsonify({"error": str(e)}), 403

    payload = request.get_json(silent=True) or {}
    user = payload.get("username", "")
    if not USERNAME_RE.match(user):
        return jsonify({"error": "bad username"}), 400

    res = call_provision("heartbeat", user)
    if res.returncode != 0:
        return (
            jsonify({"error": "no active session", "detail": res.stderr.strip()[:200]}),
            410,  # Gone
        )
    return jsonify({"ok": True})


if __name__ == "__main__":
    # PoC server; behind nginx / caddy in production for TLS termination.
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
