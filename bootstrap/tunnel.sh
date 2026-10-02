#!/usr/bin/env bash
# Runs the Cloudflare tunnel as a host service, outside Kubernetes, so SSH and
# the Kubernetes API stay reachable even if the cluster is broken.
#   sudo ./bootstrap/tunnel.sh /path/to/credentials.json
# credentials.json comes from creating a locally-managed tunnel
# ({"AccountTag","TunnelID","TunnelSecret"}). It is a secret: it lives in
# /etc/cloudflared on the box and never in this repo.
#
# Routes (hostnames from HOST_SUFFIX in clusters/proof/settings.yaml):
#   k8s<suffix>  -> Kubernetes API   (put Cloudflare Access in front first)
#   ssh<suffix>  -> SSH              (put Cloudflare Access in front first)
#   anything else pointed at the tunnel -> Traefik on :80, which routes by Host
set -euo pipefail

CREDS=${1:?usage: tunnel.sh <credentials.json>}
CLOUDFLARED_VERSION=2026.9.3
HERE=$(cd "$(dirname "$0")" && pwd)
SUFFIX=$(sed -n 's/^  HOST_SUFFIX: *"\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$HERE/../clusters/proof/settings.yaml")
[ -n "$SUFFIX" ] || { echo "HOST_SUFFIX not found in settings.yaml"; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }

case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "unsupported arch $(uname -m)"; exit 1 ;;
esac

echo "==> cloudflared ${CLOUDFLARED_VERSION}"
if [ "$(cloudflared --version 2>/dev/null | awk '{print $3}')" != "$CLOUDFLARED_VERSION" ]; then
  curl -sfL -o /usr/local/bin/cloudflared \
    "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${ARCH}"
  chmod 0755 /usr/local/bin/cloudflared
fi

install -d -m 0700 /etc/cloudflared
install -m 0600 "$CREDS" /etc/cloudflared/credentials.json
TUNNEL_ID=$(sed -n 's/.*"TunnelID": *"\([^"]*\)".*/\1/p' /etc/cloudflared/credentials.json)
cat > /etc/cloudflared/config.yml <<YAML
tunnel: ${TUNNEL_ID}
credentials-file: /etc/cloudflared/credentials.json
ingress:
  - hostname: k8s${SUFFIX}
    service: tcp://localhost:6443
  - hostname: ssh${SUFFIX}
    service: ssh://localhost:22
  - service: http://localhost:80
YAML

cat > /etc/systemd/system/cloudflared.service <<'UNIT'
[Unit]
Description=Cloudflare tunnel
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/cloudflared --no-autoupdate --config /etc/cloudflared/config.yml tunnel run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now cloudflared
systemctl restart cloudflared
echo "tunnel ${TUNNEL_ID} running; point DNS for app${SUFFIX}, k8s${SUFFIX}, ssh${SUFFIX} at ${TUNNEL_ID}.cfargotunnel.com"
