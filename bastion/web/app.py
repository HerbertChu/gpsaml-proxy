"""
gpsaml-proxy web / API.

Lives between the SAML-aware gpsaml client (browser extension or
Electron app) and the privileged provision helper. Validates
HMAC-signed requests, calls out to `sudo provision …`, and hands a
one-shot .command download URL back to the client. The web process
itself runs unprivileged (as the `gpw` user); the only thing it can
do as root is execute provision via a NOPASSWD sudoers entry.
"""

import hashlib
import hmac
import json
import os
import pathlib
import re
import subprocess

from flask import Flask, Response, jsonify, request, send_from_directory

# ── config ──────────────────────────────────────────────────────────
PROVISION = "/opt/gpsaml-proxy/bin/provision"
USERNAME_RE = re.compile(r"^[a-z][a-z0-9_-]{1,30}$")
SECRET_PATH = pathlib.Path(
    os.environ.get("GPSAML_PROXY_SECRET", "/etc/gpsaml-proxy/secret")
)
STATIC_DIR = pathlib.Path(__file__).resolve().parent.parent / "static"

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")


# ── CORS for the browser extension ────────────────────────────────
# The MV3 service worker fetches /api/connect from a chrome-extension
# origin, which the browser treats as cross-origin. Allow * so any
# extension build (its ID changes each unpacked load) reaches us;
# the request is still authenticated by the HMAC signature.
@app.after_request
def add_cors_headers(resp: Response) -> Response:
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "POST, GET, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = (
        "Content-Type, X-GPSAML-Signature"
    )
    return resp


@app.route("/api/connect", methods=["OPTIONS"])
@app.route("/api/disconnect", methods=["OPTIONS"])
@app.route("/api/heartbeat", methods=["OPTIONS"])
def cors_preflight():
    return ("", 204)


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
    # First observed successful run took ~168s end-to-end (HIP + auth +
    # tunnel-up). spawn_openconnect's own deadline is 150s; give the
    # outer call enough headroom for cmd_down rollback (10s SIGTERM
    # grace + setup), so 300s total. gunicorn worker timeout is 180s
    # by default — must also be bumped (see systemd unit).
    return subprocess.run(
        ["sudo", "-n", PROVISION, *args],
        capture_output=True,
        text=True,
        timeout=300,
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
    forwards_in = payload.get("forwards", []) or []

    if not USERNAME_RE.match(user):
        return jsonify({"error": f"bad username: {user!r}"}), 400
    if not all([cookie, gateway, fingerprint]):
        return jsonify({"error": "missing authcookie, gateway, or fingerprint"}), 400

    # Provision accepts forwards as a JSON arg — extension may send any
    # subset; we sanitize hostname / port here before passing through.
    sanitized = []
    for f in forwards_in:
        host = str(f.get("hostname", "")).strip()
        try:
            port = int(f.get("port", 0))
        except (TypeError, ValueError):
            continue
        if not host or port < 1 or port > 65535:
            continue
        if not re.match(r"^[a-zA-Z0-9][a-zA-Z0-9.-]{0,253}$", host):
            continue
        sanitized.append({"hostname": host, "port": port})
    forwards_arg = json.dumps(sanitized)

    log_path = pathlib.Path("/var/log/gpsaml-proxy/provision.log")
    try:
        res = call_provision("up", user, cookie, gateway, fingerprint, forwards_arg)
    except subprocess.TimeoutExpired as e:
        # Provision is killed mid-flight by call_provision's timeout.
        # Capture whatever stderr/stdout we got before the kill so
        # debugging doesn't have to go via SSM. provision also writes
        # its own trace to /var/log/gpsaml-proxy/provision.log directly,
        # but those go to the still-running orphan; this records the
        # client-visible side.
        try:
            with log_path.open("a") as fh:
                fh.write(f"\n===== {user} TIMEOUT after {e.timeout}s =====\n")
                if e.stderr:
                    stderr = e.stderr.decode("utf-8", "replace") if isinstance(e.stderr, bytes) else e.stderr
                    fh.write(stderr)
                fh.write("\n----- stdout -----\n")
                if e.stdout:
                    stdout = e.stdout.decode("utf-8", "replace") if isinstance(e.stdout, bytes) else e.stdout
                    fh.write(stdout)
                fh.write("\n")
        except Exception:
            pass
        return jsonify({"error": "provision timed out", "timeout": e.timeout}), 504
    if res.returncode == 3:
        return jsonify({"error": "bastion at capacity"}), 503
    if res.returncode != 0:
        try:
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

    # Provision now emits a JSON envelope on stdout — older "raw key
    # to stdout" callers should be retired. If parsing fails we fall
    # back to the raw-key mode so older clients don't hard break.
    try:
        envelope = json.loads(res.stdout)
        private_key = envelope["private_key"]
        ns_ip = envelope["ns_ip"]
        forwards = envelope.get("forwards", [])
    except (json.JSONDecodeError, KeyError):
        private_key = res.stdout
        ns_ip = None
        forwards = []

    bastion_host = request.host.split(":")[0]
    if not ns_ip:
        ns_ip = "127.0.0.1"

    # Build the recommended ssh -L command. Privileged ports are
    # remapped to 8000+offset so the user's ssh runs without sudo —
    # they then access the corp service at https://<host>:<localport>/.
    # Cert validates because the SNI / hostname is unchanged.
    ssh_args = ["-N"]
    forward_table = []
    hosts_lines = []
    for f in forwards:
        port = int(f["port"])
        local_port = port if port >= 1024 else 8000 + port
        ssh_args.append(f"-L {local_port}:{ns_ip}:{port}")
        # Two URL forms — `localhost_url` works with no /etc/hosts
        # edit (cert warning expected), `clean_url` is what the user
        # gets after they paste the hosts_cmd line below.
        port_suffix = f":{local_port}" if local_port != 443 else ""
        forward_table.append({
            "hostname": f["hostname"],
            "remote_port": port,
            "local_port": local_port,
            "localhost_url": f"https://localhost:{local_port}/",
            "clean_url": f"https://{f['hostname']}{port_suffix}/",
        })
        hosts_lines.append(f"127.0.0.1 {f['hostname']}")
    ssh_cmd = (
        f"ssh {' '.join(ssh_args)} "
        f"-i ~/Downloads/gpsaml-bastion-id "
        f"-o StrictHostKeyChecking=accept-new "
        f"{user}@{bastion_host}"
    )
    # /etc/hosts patch — one echo|tee per line is cleaner than a
    # heredoc and works in shells that don't like the EOF syntax
    # (zsh on macOS handles both fine, but copy-paste from popups
    # sometimes mangles the heredoc).
    hosts_cmd = "\n".join(
        f"echo '{line}  # gpsaml-bastion' | sudo tee -a /etc/hosts"
        for line in hosts_lines
    )

    return jsonify({
        "private_key": private_key,
        "ssh_user": user,
        "ssh_host": bastion_host,
        "ns_ip": ns_ip,
        "forwards": forward_table,
        "ssh_cmd": ssh_cmd,
        "hosts_cmd": hosts_cmd,
    })


@app.get("/download/extension.zip")
def download_extension():
    """Zip the extension directory on demand and serve it. Source
    lives at /opt/gpsaml-proxy/extension on the bastion."""
    import io
    import zipfile

    ext_dir = pathlib.Path("/opt/gpsaml-proxy/extension")
    if not ext_dir.exists():
        return ("extension dir missing", 500)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(ext_dir.rglob("*")):
            if p.is_file():
                zf.write(p, arcname=str(p.relative_to(ext_dir)))
    buf.seek(0)
    return Response(
        buf.getvalue(),
        mimetype="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="gpsaml-bastion.zip"',
        },
    )


@app.post("/api/disconnect")
def disconnect():
    # Two callers: the browser extension (signed) and the .command
    # script's trap → curl (unsigned, no secret to embed in plain
    # text on every laptop). Treat /api/disconnect as best-effort and
    # accept either an HMAC-signed body or an unsigned body — the
    # only side-effect is tearing down a session that's already
    # expected to terminate, so the security cost of a missing
    # signature is bounded.
    try:
        verify_hmac()
    except (PermissionError, FileNotFoundError):
        # Unsigned is OK here for the .command trap path.
        pass

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
