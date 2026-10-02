# omatwodee2

An opinionated way to run your own apps on one cheap server, built from three things: any VPS, GitHub and Cloudflare. The shape of everything (apps, domains, databases) lives in this repo, and Flux on the server applies whatever is on `main`. Nothing on the server is open to the internet: all traffic, including SSH and the Kubernetes API, arrives through a Cloudflare tunnel. Nobody logs into a dashboard, because there isn't one; you or your agent drive it.

## What's in it

Four pieces in the cluster, all CNCF projects with real backing, plus Cloudflare's tunnel on the host. Everything else is plain YAML in this repo.

| Piece | Version | Job |
|---|---|---|
| k3s | v1.36.5+k3s1 (stable channel) | Kubernetes in one binary. Ships Traefik for routing and local-path for storage |
| Flux | v2.9.6 | Applies this repo to the cluster, and decrypts secrets |
| SOPS + age | 3.13.3 / 1.3.2 | Secrets are committed encrypted |
| CloudNativePG | 1.30.1 (chart 0.29.1) | One shared Postgres, a database per app |
| cloudflared | 2026.9.3 (host service) | The tunnel. HTTPS ends at Cloudflare's edge, so no certificates on the box |

## Layout

```
bootstrap/                 install.sh turns a fresh box into a cluster; tunnel.sh runs the tunnel
clusters/proof/            what Flux applies, in order: controllers, then configs, then apps
  settings.yaml            the one file you edit per cluster (HOST_SUFFIX)
infrastructure/
  controllers/             CloudNativePG
  configs/                 shared Postgres, admission policy
apps/                      one folder per app
scripts/check.sh           offline checks (render, schemas, lint, secrets)
scripts/smoke.sh           live checks against a running cluster
```

## Set up a server

First create a locally-managed Cloudflare tunnel and save its `credentials.json` (`{"AccountTag","TunnelID","TunnelSecret"}`). Then, on a fresh Debian or Ubuntu box:

```sh
git clone https://github.com/<you>/<repo> && cd <repo>
sudo TUNNEL_CREDENTIALS=/path/to/credentials.json ./bootstrap/install.sh https://github.com/<you>/<repo>
```

The script installs k3s and Flux, creates the cluster's encryption key **on the box**, and points Flux at the repo. At the end it prints a public key. Put that key in `.sops.yaml` and commit it. Back up the private key it names somewhere off the box. If it's lost, every encrypted secret in the repo is unreadable.

Then set `HOST_SUFFIX` in `clusters/proof/settings.yaml` and commit. In Cloudflare:

1. Create Access applications for `k8s<suffix>` and `ssh<suffix>` (your email, plus a service token for your agent) **before** pointing DNS at them.
2. Point each app's hostname, plus `k8s<suffix>` and `ssh<suffix>`, at `<tunnel-id>.cfargotunnel.com` as proxied CNAMEs.
3. Once the site, SSH and the API work through the tunnel and survive a reboot, close every inbound port on the box's firewall.

Keep hostnames one level below the zone (`app-x.example.com`, not `app.x.example.com`) so Cloudflare's free certificate covers them.

**Break glass:** with no inbound ports, a broken tunnel means no SSH. Use your provider's serial or web console to get in.

### Two secrets that can't come from the repo

Flux needs some things before it can read the repo, so they can't live in it. The encryption key (`sops-age`) is created by `install.sh` on the box. The tunnel credential is copied to `/etc/cloudflared` by `tunnel.sh`. A deploy key is only needed if the repo is private. Every other secret goes into git, encrypted.

## Add an app

Copy `apps/whoami/`, rename it, change the image and host, and add the folder to `apps/kustomization.yaml`. Run `./scripts/check.sh`. Commit. Flux deploys it within a minute.

Flux replaces `${NAME}` with values from `settings.yaml`, so a literal `$` in a manifest (a shell argument, say) must be written as `$$`.

## Secrets

Encrypting needs only the public key in `.sops.yaml`. That's all an agent working on this repo should ever hold:

```sh
sops --encrypt --in-place apps/myapp/secret.sops.yaml
```

To change a value, write the whole secret again and re-encrypt it. Don't decrypt and edit; that needs the private key, which stays on the cluster.

## Checks

- `./scripts/check.sh` runs anywhere: it renders every entry point, validates it against the Kubernetes and CRD schemas, lints the scripts, refuses plaintext Secrets, and does a SOPS round trip.
- CI runs that, then boots the real stack on a throwaway k3s, on x86 and ARM, and runs `scripts/smoke.sh`. The smoke test checks that Flux is ready, Postgres is up, the app answers through Traefik, a privileged container is rejected, and records memory use.

Tools are pinned in `mise.toml`. Run `mise install`.

## Deliberate choices for v1

- **Plain Ingress, not Gateway API.** Ingress needs no extra setup on k3s. Gateway API needs Traefik config, and from k3s 1.37 a separate CRD chart.
- **Behind Cloudflare by default.** HTTPS ends at Cloudflare's edge and the box has no open ports. To serve directly instead, open 80/443 and bring back cert-manager (it was in this repo until the tunnel commit; see the git history).
- **No preview environments, backups or monitoring yet.** Backups to S3-compatible storage come next. Previews and monitoring come once the core has been proven on real hardware.
