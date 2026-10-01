#!/usr/bin/env bash
# Live checks against a running cluster. Used by CI and on a real box.
#   KUBECTL="sudo k3s kubectl" ./scripts/smoke.sh
set -euo pipefail
read -r -a K <<<"${KUBECTL:-kubectl}"
DOMAIN=$("${K[@]}" -n flux-system get configmap cluster-settings -o jsonpath='{.data.DOMAIN}')

step() { printf '\n==> %s\n' "$1"; }

step "Flux Kustomizations ready"
for ks in cluster controllers configs apps; do
  "${K[@]}" -n flux-system wait kustomization/"$ks" --for=condition=Ready --timeout=600s
done

step "Postgres ready"
"${K[@]}" -n database wait cluster.postgresql.cnpg.io/shared --for=condition=Ready --timeout=600s

step "whoami serving through Traefik"
"${K[@]}" -n whoami rollout status deploy/whoami --timeout=300s
for _ in $(seq 1 30); do
  if curl -fsS -H "Host: whoami.${DOMAIN}" http://127.0.0.1/ | grep -q '^Hostname:'; then ok=1; break; fi
  sleep 5
done
[ "${ok:-}" = 1 ] || { echo "whoami did not answer through Traefik"; exit 1; }
echo "answered on whoami.${DOMAIN}"

step "admission policy blocks a privileged container"
priv=$(cat <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: smoke-priv
  namespace: whoami
spec:
  selector:
    matchLabels: {app: smoke-priv}
  template:
    metadata:
      labels: {app: smoke-priv}
    spec:
      containers:
        - name: x
          image: busybox
          securityContext:
            privileged: true
YAML
)
if out=$("${K[@]}" apply --dry-run=server -f - <<<"$priv" 2>&1); then
  echo "privileged deployment was ALLOWED"; exit 1
fi
grep -q "Privileged containers are not allowed" <<<"$out" || { echo "rejected for the wrong reason: $out"; exit 1; }
echo "denied, as it should be"

step "memory"
"${K[@]}" top node 2>/dev/null || echo "(metrics not ready yet)"
free -m

echo; echo "SMOKE PASSED"
