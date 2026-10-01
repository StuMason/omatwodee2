# omakase (working name)

An opinionated, git-driven way to run your own apps on one cheap server. The whole setup lives in this repo. Flux, running on the server, applies whatever is on `main`. You or your agent change things by committing. Nobody logs into a dashboard, because there isn't one.

## What's in it

Five pieces, all CNCF projects with real backing. Everything else is plain YAML in this repo.

| Piece | Version | Job |
|---|---|---|
| k3s | v1.36.5+k3s1 (stable channel) | Kubernetes in one binary. Ships Traefik for routing and local-path for storage |
| Flux | v2.9.6 | Applies this repo to the cluster, and decrypts secrets |
| cert-manager | v1.21.2 | HTTPS certificates from Let's Encrypt |
| SOPS + age | 3.13.3 / 1.3.2 | Secrets are committed encrypted |
| CloudNativePG | 1.30.1 (chart 0.29.1) | One shared Postgres, a database per app |

## Layout

```
bootstrap/                 install.sh turns a fresh box into a cluster that runs this repo
clusters/proof/            what Flux applies, in order: controllers, then configs, then apps
  settings.yaml            the one file you edit per cluster (domain, email)
infrastructure/
  controllers/             cert-manager and CloudNativePG
  configs/                 certificate issuer, shared Postgres, admission policy
apps/                      one folder per app
scripts/check.sh           offline checks (render, schemas, lint, secrets)
scripts/smoke.sh           live checks against a running cluster
```

## Set up a server

On a fresh Debian or Ubuntu box with ports 80 and 443 open:

```sh
git clone https://github.com/<you>/<repo> && cd <repo>
sudo ./bootstrap/install.sh https://github.com/<you>/<repo>
```

The script installs k3s and Flux, creates the cluster's encryption key **on the box**, and points Flux at the repo. At the end it prints a public key. Put that key in `.sops.yaml` and commit it. Back up the private key it names somewhere off the box. If it's lost, every encrypted secret in the repo is unreadable.

Then set `DOMAIN` in `clusters/proof/settings.yaml`, point `*.your-domain` at the box, and commit.

### Two secrets that can't come from the repo

Flux needs two things before it can read the repo, so they can't live in it. The encryption key (`sops-age`) is created by `install.sh` on the box. A deploy key is only needed if the repo is private; v1 assumes a public repo. Every other secret goes into git, encrypted.

## Add an app

Copy `apps/whoami/`, rename it, change the image and host, and add the folder to `apps/kustomization.yaml`. Run `./scripts/check.sh`. Commit. Flux deploys it within a minute.

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
- **HTTP-01 certificates, not wildcard DNS-01.** No DNS provider token needed. Wildcards only matter for preview environments.
- **No preview environments, backups or monitoring yet.** Backups to S3-compatible storage come next. Previews and monitoring come once the core has been proven on real hardware.
