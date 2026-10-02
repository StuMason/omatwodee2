#!/usr/bin/env bash
# Turns a fresh Debian/Ubuntu box into a cluster that runs this repo.
# Run as root from a checkout of the repo:
#   sudo ./bootstrap/install.sh https://github.com/<you>/<repo> [branch]
# With TUNNEL_CREDENTIALS=/path/credentials.json set, it also runs the
# Cloudflare tunnel (bootstrap/tunnel.sh). Without it, the tunnel is skipped.
set -euo pipefail

REPO_URL=${1:?usage: install.sh <repo-url> [branch]}
BRANCH=${2:-main}
CLUSTER=${CLUSTER:-proof}   # which clusters/<name> directory this box runs
K3S_VERSION=v1.36.5+k3s1
FLUX_VERSION=v2.9.6
AGE_VERSION=v1.3.2
KEY_DIR=/var/lib/omakase
HERE=$(cd "$(dirname "$0")" && pwd)

[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }

case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "unsupported arch $(uname -m)"; exit 1 ;;
esac

echo "==> k3s ${K3S_VERSION}"
install -D -m 0600 "$HERE/k3s-config.yaml" /etc/rancher/k3s/config.yaml
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="$K3S_VERSION" sh -s - server
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
# The installer returns before the API server is up and the node has registered.
until kubectl get nodes --no-headers 2>/dev/null | grep -q .; do sleep 3; done
kubectl wait --for=condition=Ready node --all --timeout=180s

echo "==> Flux ${FLUX_VERSION}"
kubectl apply -f "https://github.com/fluxcd/flux2/releases/download/${FLUX_VERSION}/install.yaml"
kubectl -n flux-system wait --for=condition=Available deployment --all --timeout=300s

echo "==> age key (created here, never leaves this box)"
if ! command -v age-keygen >/dev/null; then
  curl -sfL "https://github.com/FiloSottile/age/releases/download/${AGE_VERSION}/age-${AGE_VERSION}-linux-${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin --strip-components=1 age/age age/age-keygen
fi
install -d -m 0700 "$KEY_DIR"
[ -f "$KEY_DIR/age.key" ] || age-keygen -o "$KEY_DIR/age.key" 2>/dev/null
chmod 0600 "$KEY_DIR/age.key"
kubectl -n flux-system create secret generic sops-age \
  --from-file=age.agekey="$KEY_DIR/age.key" --dry-run=client -o yaml | kubectl apply -f -

echo "==> point Flux at ${REPO_URL} (${BRANCH}, clusters/${CLUSTER})"
kubectl apply -f - <<YAML
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: omakase
  namespace: flux-system
spec:
  interval: 1m
  url: ${REPO_URL}
  ref:
    branch: ${BRANCH}
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: cluster
  namespace: flux-system
spec:
  interval: 10m
  path: ./clusters/${CLUSTER}
  prune: true
  sourceRef:
    kind: GitRepository
    name: omakase
YAML

if [ -n "${TUNNEL_CREDENTIALS:-}" ]; then
  "$HERE/tunnel.sh" "$TUNNEL_CREDENTIALS"
else
  echo "==> tunnel skipped (no TUNNEL_CREDENTIALS)"
fi

PUB=$(age-keygen -y "$KEY_DIR/age.key")
cat <<MSG

Done. Flux is now applying the repo.

1. Put this public key in .sops.yaml (replace the placeholder) and commit:
     ${PUB}
2. Back up the private key OFF this box, somewhere only you can reach:
     ${KEY_DIR}/age.key
   Lose it and every encrypted secret in the repo is unreadable.
3. Watch it come up:
     kubectl get kustomizations -A -w
MSG
