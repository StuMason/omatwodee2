#!/usr/bin/env bash
# Offline checks for the whole repo. Same script runs locally and in CI.
# Render every Flux entry point, validate against schemas, lint scripts,
# prove the SOPS setup round-trips, and refuse plaintext Secrets.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

fail=0
pass() { printf '  ok    %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }
warn() { printf '  warn  %s\n' "$1"; }

K8S_VERSION=1.36.0
CRD_SCHEMAS='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
ENTRIES=(clusters/proof infrastructure/controllers infrastructure/configs apps)

echo "render + schema"
for e in "${ENTRIES[@]}"; do
  if ! out=$(kustomize build "$e" 2>&1); then bad "$e: kustomize build"; printf '        %s\n' "$out"; continue; fi
  if res=$(kubeconform -strict -summary -kubernetes-version "$K8S_VERSION" \
        -schema-location default -schema-location "$CRD_SCHEMAS" - <<<"$out" 2>&1); then
    pass "$e ($(tail -1 <<<"$res"))"
  else
    bad "$e"; grep -v '^Summary' <<<"$res" | sed 's/^/        /'
  fi
done

echo "scripts"
mapfile -t scripts < <(find bootstrap scripts -name '*.sh')
if shellcheck "${scripts[@]}"; then pass "shellcheck (${#scripts[@]} files)"; else bad "shellcheck"; fi

echo "secrets"
plain=$(grep -rlE '^kind: *Secret' --include='*.yaml' . | grep -v '\.sops\.yaml$' || true)
if [ -z "$plain" ]; then pass "no plaintext Secret manifests"; else bad "plaintext Secret in: $plain"; fi
while IFS= read -r f; do
  if grep -q '^sops:' "$f"; then pass "$f is encrypted"; else bad "$f is not encrypted"; fi
done < <(find . -name '*.sops.yaml' -not -name '.sops.yaml' -not -path './.git/*')
grep -q 'age1placeholder' .sops.yaml && warn ".sops.yaml still has the placeholder key (run bootstrap, paste the printed key)"

echo "sops round-trip (throwaway key)"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
age-keygen -o "$tmp/key" 2>/dev/null
pub=$(age-keygen -y "$tmp/key")
sed "s/age1placeholder[a-z0-9]*/$pub/" .sops.yaml > "$tmp/.sops.yaml"
cat > "$tmp/test.sops.yaml" <<'YAML'
apiVersion: v1
kind: Secret
metadata:
  name: roundtrip
stringData:
  token: hunter2
YAML
if (cd "$tmp" && sops --encrypt --in-place test.sops.yaml) \
   && ! grep -q hunter2 "$tmp/test.sops.yaml" \
   && grep -q 'name: roundtrip' "$tmp/test.sops.yaml" \
   && [ "$(SOPS_AGE_KEY_FILE="$tmp/key" sops --decrypt --extract '["stringData"]["token"]' "$tmp/test.sops.yaml")" = hunter2 ]; then
  pass "encrypt with public key only, metadata stays readable, decrypt with private key"
else
  bad "sops round-trip"
fi

echo
[ $fail -eq 0 ] && echo "ALL CHECKS PASSED" || echo "CHECKS FAILED"
exit $fail
