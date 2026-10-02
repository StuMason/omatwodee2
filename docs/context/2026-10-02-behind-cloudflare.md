# Behind Cloudflare: host tunnel, HOST_SUFFIX, cert-manager removed

**Date:** 2026-10-02

## Provenance

| Field | Value |
|---|---|
| **Model** | `claude-opus-5-5` |
| **Harness** | `claude-code 2.1.287` |
| **Session ID** | dfd025b3-08de-40b6-846e-77813f329771 |
| **Review status** | `agent-reviewed` (advisor model reviewed the design; no human read the diff) |
| **Confidence** | `medium` |
| **Triggered by** | `human-request` |
| **Touched areas** | `infra`, `networking`, `tls`, `config` |
| **Test status** | `tests-modified` (smoke.sh reads HOST_SUFFIX) |
| **Dependencies introduced** | cloudflared 2026.9.3 (host binary, systemd) |
| **Dependencies removed** | cert-manager |

## What was asked

Stu disliked Tailscale lock-in and chose: "yes CF tunnel, put everything behind cloudflare". Earlier he set the stack as Cloudflare + GitHub + any VPS.

## What changed

- `bootstrap/tunnel.sh` installs pinned cloudflared on the host as a systemd service with a locally-managed config: `k8s<suffix>` to the API (tcp/6443), `ssh<suffix>` to sshd, everything else to Traefik on :80. `install.sh` runs it only when `TUNNEL_CREDENTIALS` is set (CI skips it).
- `settings.yaml`: `DOMAIN` replaced by `HOST_SUFFIX`; app hosts are `<app>${HOST_SUFFIX}`.
- cert-manager and the ClusterIssuer removed; whoami Ingress has no TLS block. HTTPS ends at Cloudflare's edge.
- smoke.sh and README updated.

## Decisions made

- **Tunnel on the host, not in the cluster**, so admin access (SSH, API) survives a broken cluster, and CI never needs the credential.
- **First-level hostnames** (`whoami-or2.stumason.dev`) because the zone's free Universal cert covers one level only. The advanced-cert quota read 0 allocated / 4 used, so the cost of a new pack was unknown; not gambled.
- **Behind Cloudflare is now the recipe default.** Direct 80/443 + cert-manager remains in git history.

## Risk surface

- Tunnel credential is a secret on the box (`/etc/cloudflared`, 0600) and on the operator machine; never in the repo.
- `k8s<suffix>` and `ssh<suffix>` must have Cloudflare Access apps before DNS points at them, or they are reachable by anyone running cloudflared.
- With all inbound ports closed, a broken tunnel needs the provider's serial console.
- Orphaned objects after prune: the `whoami-tls` Secret may remain. Harmless.
