# Initial stack: k3s, Flux, cert-manager, SOPS, CloudNativePG

**Date:** 2026-10-01

## Provenance

| Field | Value |
|---|---|
| **Model** | `claude-opus-5-5` |
| **Harness** | `claude-code 2.1.287` (background job, auto mode) |
| **Harness config** | Bash, file tools, web research subagents; no cluster access |
| **Session ID** | dfd025b3-08de-40b6-846e-77813f329771 |
| **Generation timestamp** | 2026-10-01T22:00:00Z |
| **Review status** | `none` (one advisor-model review of the plan before writing; no human has read the diff) |
| **Confidence** | `medium`: offline checks pass; nothing has booted on a real cluster yet |
| **Triggered by** | `human-request` |
| **Touched areas** | `infra`, `config`, `secrets`, `admission-policy` |
| **Test status** | `tests-added` (scripts/check.sh offline; scripts/smoke.sh + CI boot job, not yet run) |
| **Dependencies introduced** | k3s v1.36.5+k3s1, Flux v2.9.6, cert-manager v1.21.2 (chart), CloudNativePG 1.30.1 (chart 0.29.1), SOPS 3.13.3, age 1.3.2, traefik/whoami v1.12.0 (demo), mise toolchain (kubectl, kustomize, flux2, sops, age, kubeconform, shellcheck), GitHub Actions jdx/mise-action@v3 and actions/checkout@v5 |
| **Dependencies reimplemented** | App manifests written as plain Kustomize instead of a shared Helm chart (bjw-s app-template) |

> **Deps-Reimplemented limitation:** self-reported; `none` would not mean no reimplementation occurred.

## What was asked

The owner wants an opinionated, agent-operated way to self-host apps on Kubernetes, "the Omarchy of self hosting", shipped as a skill plus a repo rather than a dashboard product. After research, they set the rule: "keep it simple tho - I am not happy about how much of the libraries you're using are abandoned". Then: "ok start the repo and do a check pre and post".

Not asked for: preview environments, backups, monitoring, a public remote. The repo name is undecided, so nothing is pushed.

## What changed

New repo with:

- `bootstrap/install.sh` + `k3s-config.yaml`: installs pinned k3s (embedded etcd, secrets encryption at rest), applies Flux from its pinned release manifest, creates the age key on the box and loads it as the `sops-age` Secret, creates the GitRepository and the root `cluster` Kustomization, prints the public key and backup instructions.
- `clusters/proof/`: `settings.yaml` (ConfigMap substituted into configs and apps), three Flux Kustomizations chained controllers -> configs -> apps, SOPS decryption on configs and apps.
- `infrastructure/controllers/`: HelmRepository + HelmRelease for cert-manager (CRDs on) and CloudNativePG.
- `infrastructure/configs/`: Let's Encrypt ClusterIssuer (HTTP-01 via Traefik), one shared CNPG Cluster (1 instance, 10Gi), a ValidatingAdmissionPolicy denying privileged containers and hostPath volumes in app namespaces.
- `apps/whoami/`: demo app, non-root, read-only root fs, Ingress with cert-manager TLS.
- `scripts/check.sh`: offline render + kubeconform (strict, k8s 1.36 + CRD catalog schemas) + shellcheck + plaintext Secret scan + SOPS round trip with a throwaway key.
- `scripts/smoke.sh`: live checks (Flux ready, Postgres ready, app answers via Traefik, policy rejects a privileged Deployment with the expected message, memory).
- `.github/workflows/validate.yml`: check job, then boot job on x86 and ARM runners.
- `.sops.yaml` with a placeholder recipient, `mise.toml`, `.gitignore`, README.

## Why

Self-hosted PaaS tools keep state in their own database and expose partial APIs; agents work best when the whole system is text in git. Flux applies git, so the agent's only write path is a commit.

## Decisions made

- **Five dependencies only**, each a CNCF project with company or large-community backing, per the owner's rule. Cut: flux-operator, bjw-s app-template, k8up, Renovate, observability, Gatus.
- **k3s stable channel (1.36.5), not latest (1.37.1).** 1.37 also moves Traefik's Gateway API CRDs into a separate chart.
- **Flux applied from release URL, not `flux bootstrap`**, to avoid a GitHub token on the box. GitRepository and root Kustomization are bootstrap-only objects created by install.sh.
- **age private key generated on the box, never on the operator/agent machine.** The agent only ever holds the public key. This is the core safety claim.
- **Plain Ingress instead of Gateway API; HTTP-01 instead of DNS-01 wildcard.** Divergences from the research brief, chosen for simplicity, documented in the README.
- **configs Kustomization does not `wait`.** Found while writing CI: with wait, a failed ACME registration would block every app. Uncertain-ish: apps now may start before Postgres is ready; pods retry, which is acceptable.
- **ACME email optional (empty).** Let's Encrypt rejects example.com contacts, which would break CI.

## Rejected alternatives

- Argo CD (heavier; UI not wanted). Gateway API (extra config). External Secrets Operator (needs an external store). Shared Helm chart for apps (single-maintainer risk).

## Risk surface

- **Secrets:** SOPS with age; recipient placeholder until bootstrap. Private key at `/var/lib/omakase/age.key` (0600) on the box and in the `sops-age` Secret. Losing both makes repo secrets unrecoverable.
- **Input boundaries:** install.sh takes repo URL and branch as args, interpolated into a YAML heredoc applied with kubectl; a malicious URL could inject YAML. Run only by the box owner.
- **Supply chain:** `curl | sh` of get.k3s.io (pinned version), Flux and age downloaded from GitHub releases over HTTPS without checksum verification. Known gap.
- **Admission policy:** covers containers in Deployments/StatefulSets/DaemonSets only; not initContainers, ephemeral containers, bare Pods, Jobs or CronJobs. Known gap.
- **Assumptions:** public Git repo (no deploy key); ports 80/443 reachable; Debian/Ubuntu with systemd; Flux substitution `${VAR}` used only for settings keys.
- **Known gaps:** nothing has booted yet. No backups (CNPG to object storage needs a credential decision). No HA (single node, single Postgres instance).

## Context

Research brief and sources live outside this repo. Proof hardware (a free-tier ARM box) is still being provisioned; CI will run once the repo is pushed under its final name.
