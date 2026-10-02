/**
 * The cluster, seen as apps. Every tool goes through this interface, so tools
 * are tested against a fake and the Kubernetes details stay in one place.
 *
 * An app is a namespace labelled `or2.stumason.dev/app=true`. Runtime env
 * values live in a Secret named `runtime-env` in the app's namespace: Flux
 * does not manage it, so changes made here are never reverted by a sync.
 * Deployments pick it up with `envFrom: [{secretRef: {name: runtime-env, optional: true}}]`.
 *
 * The process runs as the or2-agent ServiceAccount, so Kubernetes RBAC is the
 * real boundary; the app-label check here just gives clearer errors.
 */

import * as k8s from '@kubernetes/client-node';
import { PassThrough } from 'node:stream';

export const APP_LABEL = 'or2.stumason.dev/app';
export const RUNTIME_ENV_SECRET = 'runtime-env';
const FIELD_MANAGER = 'or2-mcp';

export interface DeploymentSummary {
  name: string;
  ready: number;
  desired: number;
  images: string[];
}
export interface AppSummary {
  name: string;
  deployments: DeploymentSummary[];
  hosts: string[];
}
export interface PodSummary {
  name: string;
  phase: string;
  ready: boolean;
  restarts: number;
  startedAt?: string;
  waiting?: string;
  lastTermination?: string;
}
export interface AppDetail extends AppSummary {
  pods: PodSummary[];
  cronjobs: { name: string; schedule: string; lastScheduled?: string; suspended: boolean }[];
  warnings: { reason: string; message: string; object: string; count: number; last?: string }[];
}
export interface LogOptions {
  deployment?: string;
  container?: string;
  lines: number;
  sinceMinutes?: number;
  previous?: boolean;
}
export interface Usage {
  nodes: { name: string; cpu: string; memory: string }[];
  pods: { namespace: string; name: string; cpu: string; memory: string }[];
}
export interface ClusterStatus {
  nodes: { name: string; ready: boolean; version: string }[];
  flux: { name: string; ready: boolean; message: string }[];
  postgres: { name: string; phase: string; ready: boolean; archiving: string }[];
  lastBackup?: { name: string; phase: string; stoppedAt?: string };
  apps: AppSummary[];
}
export interface ExecResult {
  pod: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}
export interface BackupSummary {
  name: string;
  createdAt?: string;
  phase: string;
  method?: string;
  startedAt?: string;
  stoppedAt?: string;
  error?: string;
}

export interface Cluster {
  listApps(): Promise<AppSummary[]>;
  getApp(app: string): Promise<AppDetail>;
  logs(app: string, options: LogOptions): Promise<{ pod: string; text: string }>;
  usage(): Promise<Usage>;
  status(): Promise<ClusterStatus>;
  restart(app: string, deployment?: string): Promise<string[]>;
  scale(app: string, replicas: number, deployment?: string): Promise<string[]>;
  envKeys(app: string): Promise<string[]>;
  envSet(app: string, values: Record<string, string>): Promise<string[]>;
  envUnset(app: string, keys: string[]): Promise<string[]>;
  exec(app: string, command: string[], deployment?: string): Promise<ExecResult>;
  backupNow(): Promise<string>;
  listBackups(): Promise<BackupSummary[]>;
}

export class NotAnAppError extends Error {}

/** Kubernetes CPU quantity (e.g. "152839126n", "250m", "2") as millicores: "153m". */
export function cpu(value: unknown): string {
  const raw = String(value ?? '0');
  const m = /^([0-9.]+)([num]?)$/.exec(raw);
  if (!m) return raw;
  const n = Number(m[1]);
  const milli = m[2] === 'n' ? n / 1e6 : m[2] === 'u' ? n / 1e3 : m[2] === 'm' ? n : n * 1000;
  return `${Math.round(milli)}m`;
}

/** Kubernetes memory quantity (e.g. "2658000Ki") as MiB/GiB: "2.5Gi". */
export function memory(value: unknown): string {
  const raw = String(value ?? '0');
  const m = /^([0-9.]+)(Ki|Mi|Gi|K|M|G)?$/.exec(raw);
  if (!m) return raw;
  const factor: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, K: 1e3, M: 1e6, G: 1e9 };
  const bytes = Number(m[1]) * (m[2] ? factor[m[2]] ?? 1 : 1);
  const mib = bytes / 1024 ** 2;
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)}Gi` : `${Math.round(mib)}Mi`;
}

export class K8sCluster implements Cluster {
  private readonly core: k8s.CoreV1Api;
  private readonly apps: k8s.AppsV1Api;
  private readonly net: k8s.NetworkingV1Api;
  private readonly batch: k8s.BatchV1Api;
  private readonly custom: k8s.CustomObjectsApi;
  private readonly objects: k8s.KubernetesObjectApi;
  private readonly metrics: k8s.Metrics;
  private readonly execApi: k8s.Exec;

  constructor(
    kc: k8s.KubeConfig,
    private readonly databaseNamespace = 'database',
    private readonly postgresCluster = 'shared',
  ) {
    this.core = kc.makeApiClient(k8s.CoreV1Api);
    this.apps = kc.makeApiClient(k8s.AppsV1Api);
    this.net = kc.makeApiClient(k8s.NetworkingV1Api);
    this.batch = kc.makeApiClient(k8s.BatchV1Api);
    this.custom = kc.makeApiClient(k8s.CustomObjectsApi);
    this.objects = k8s.KubernetesObjectApi.makeApiClient(kc);
    this.metrics = new k8s.Metrics(kc);
    this.execApi = new k8s.Exec(kc);
  }

  private async appNames(): Promise<string[]> {
    const list = await this.core.listNamespace({ labelSelector: `${APP_LABEL}=true` });
    return list.items.map((ns) => ns.metadata?.name ?? '').filter(Boolean).sort();
  }

  private async assertApp(app: string): Promise<void> {
    if (!(await this.appNames()).includes(app)) {
      throw new NotAnAppError(`"${app}" is not an app on this cluster. Use or2_apps to list them.`);
    }
  }

  private async deployments(app: string, only?: string): Promise<k8s.V1Deployment[]> {
    const list = await this.apps.listNamespacedDeployment({ namespace: app });
    const items = list.items.filter((d) => !only || d.metadata?.name === only);
    if (only && items.length === 0) throw new NotAnAppError(`no deployment "${only}" in app "${app}"`);
    return items;
  }

  private async summary(app: string): Promise<AppSummary> {
    const [deps, ingresses] = await Promise.all([
      this.deployments(app),
      this.net.listNamespacedIngress({ namespace: app }),
    ]);
    return {
      name: app,
      deployments: deps.map((d) => ({
        name: d.metadata?.name ?? '',
        ready: d.status?.readyReplicas ?? 0,
        desired: d.spec?.replicas ?? 0,
        images: (d.spec?.template.spec?.containers ?? []).map((c) => c.image ?? ''),
      })),
      hosts: ingresses.items.flatMap((i) => (i.spec?.rules ?? []).map((r) => r.host ?? '')).filter(Boolean),
    };
  }

  async listApps(): Promise<AppSummary[]> {
    return Promise.all((await this.appNames()).map((app) => this.summary(app)));
  }

  async getApp(app: string): Promise<AppDetail> {
    await this.assertApp(app);
    const [base, pods, cronjobs, events] = await Promise.all([
      this.summary(app),
      this.core.listNamespacedPod({ namespace: app }),
      this.batch.listNamespacedCronJob({ namespace: app }),
      this.core.listNamespacedEvent({ namespace: app }),
    ]);
    return {
      ...base,
      pods: pods.items.map((p) => {
        const statuses = p.status?.containerStatuses ?? [];
        const waiting = statuses.find((s) => s.state?.waiting)?.state?.waiting;
        const terminated = statuses.find((s) => s.lastState?.terminated)?.lastState?.terminated;
        return {
          name: p.metadata?.name ?? '',
          phase: p.status?.phase ?? 'Unknown',
          ready: statuses.length > 0 && statuses.every((s) => s.ready),
          restarts: statuses.reduce((n, s) => n + (s.restartCount ?? 0), 0),
          startedAt: p.status?.startTime ? new Date(p.status.startTime).toISOString() : undefined,
          waiting: waiting ? `${waiting.reason ?? ''} ${waiting.message ?? ''}`.trim() : undefined,
          lastTermination: terminated
            ? `${terminated.reason ?? 'terminated'} (exit ${terminated.exitCode})`
            : undefined,
        };
      }),
      cronjobs: cronjobs.items.map((c) => ({
        name: c.metadata?.name ?? '',
        schedule: c.spec?.schedule ?? '',
        lastScheduled: c.status?.lastScheduleTime ? new Date(c.status.lastScheduleTime).toISOString() : undefined,
        suspended: c.spec?.suspend === true,
      })),
      warnings: events.items
        .filter((e) => e.type === 'Warning')
        .sort((a, b) => String(b.lastTimestamp ?? '').localeCompare(String(a.lastTimestamp ?? '')))
        .slice(0, 15)
        .map((e) => ({
          reason: e.reason ?? '',
          message: e.message ?? '',
          object: `${e.involvedObject.kind}/${e.involvedObject.name}`,
          count: e.count ?? 1,
          last: e.lastTimestamp ? new Date(e.lastTimestamp).toISOString() : undefined,
        })),
    };
  }

  private async podFor(app: string, deployment?: string): Promise<k8s.V1Pod> {
    const deps = await this.deployments(app, deployment);
    const dep = deps[0];
    if (!dep) throw new NotAnAppError(`app "${app}" has no deployments`);
    const selector = Object.entries(dep.spec?.selector.matchLabels ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    const pods = await this.core.listNamespacedPod({ namespace: app, labelSelector: selector });
    const running = pods.items.filter((p) => p.status?.phase === 'Running');
    const pod = running[0] ?? pods.items[0];
    if (!pod) throw new NotAnAppError(`no pods for ${app}/${dep.metadata?.name}`);
    return pod;
  }

  async logs(app: string, options: LogOptions): Promise<{ pod: string; text: string }> {
    await this.assertApp(app);
    const pod = await this.podFor(app, options.deployment);
    const name = pod.metadata?.name ?? '';
    const text = await this.core.readNamespacedPodLog({
      name,
      namespace: app,
      container: options.container,
      tailLines: options.lines,
      sinceSeconds: options.sinceMinutes ? options.sinceMinutes * 60 : undefined,
      previous: options.previous,
    });
    return { pod: name, text };
  }

  async usage(): Promise<Usage> {
    const apps = new Set([...(await this.appNames()), this.databaseNamespace]);
    const [nodes, pods] = await Promise.all([this.metrics.getNodeMetrics(), this.metrics.getPodMetrics()]);
    return {
      nodes: nodes.items.map((n) => ({ name: n.metadata.name, cpu: cpu(n.usage.cpu), memory: memory(n.usage.memory) })),
      pods: pods.items
        .filter((p) => apps.has(p.metadata.namespace ?? ''))
        .map((p) => ({
          namespace: p.metadata.namespace ?? '',
          name: p.metadata.name,
          cpu: p.containers.map((c) => cpu(c.usage.cpu)).join('+'),
          memory: p.containers.map((c) => memory(c.usage.memory)).join('+'),
        })),
    };
  }

  async status(): Promise<ClusterStatus> {
    const [nodes, flux, pg, backups, apps] = await Promise.all([
      this.core.listNode(),
      this.custom.listNamespacedCustomObject({
        group: 'kustomize.toolkit.fluxcd.io',
        version: 'v1',
        namespace: 'flux-system',
        plural: 'kustomizations',
      }) as Promise<{ items: Array<Record<string, any>> }>,
      this.custom.listNamespacedCustomObject({
        group: 'postgresql.cnpg.io',
        version: 'v1',
        namespace: this.databaseNamespace,
        plural: 'clusters',
      }) as Promise<{ items: Array<Record<string, any>> }>,
      this.listBackups(),
      this.listApps(),
    ]);
    const cond = (obj: Record<string, any>, type: string): Record<string, any> | undefined =>
      (obj.status?.conditions ?? []).find((c: Record<string, any>) => c.type === type);
    const last = backups.find((b) => b.phase === 'completed') ?? backups[0];
    return {
      nodes: nodes.items.map((n) => ({
        name: n.metadata?.name ?? '',
        ready: (n.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'),
        version: n.status?.nodeInfo?.kubeletVersion ?? '',
      })),
      flux: flux.items.map((k) => ({
        name: k.metadata?.name ?? '',
        ready: cond(k, 'Ready')?.status === 'True',
        message: String(cond(k, 'Ready')?.message ?? '').slice(0, 160),
      })),
      postgres: pg.items.map((c) => ({
        name: c.metadata?.name ?? '',
        phase: String(c.status?.phase ?? ''),
        ready: cond(c, 'Ready')?.status === 'True',
        archiving: String(cond(c, 'ContinuousArchiving')?.message ?? 'unknown'),
      })),
      lastBackup: last ? { name: last.name, phase: last.phase, stoppedAt: last.stoppedAt } : undefined,
      apps,
    };
  }

  async restart(app: string, deployment?: string): Promise<string[]> {
    await this.assertApp(app);
    const deps = await this.deployments(app, deployment);
    const at = new Date().toISOString();
    for (const d of deps) {
      await this.objects.patch(
        {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: d.metadata?.name, namespace: app },
          spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': at } } } },
        } as k8s.KubernetesObject,
        undefined,
        undefined,
        FIELD_MANAGER,
        undefined,
        k8s.PatchStrategy.MergePatch,
      );
    }
    return deps.map((d) => d.metadata?.name ?? '');
  }

  async scale(app: string, replicas: number, deployment?: string): Promise<string[]> {
    await this.assertApp(app);
    const deps = await this.deployments(app, deployment);
    for (const d of deps) {
      await this.objects.patch(
        { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: d.metadata?.name, namespace: app }, spec: { replicas } } as k8s.KubernetesObject,
        undefined,
        undefined,
        FIELD_MANAGER,
        undefined,
        k8s.PatchStrategy.MergePatch,
      );
    }
    return deps.map((d) => d.metadata?.name ?? '');
  }

  private async readRuntimeEnv(app: string): Promise<k8s.V1Secret | undefined> {
    try {
      return await this.core.readNamespacedSecret({ name: RUNTIME_ENV_SECRET, namespace: app });
    } catch (error) {
      if ((error as { code?: number }).code === 404) return undefined;
      throw error;
    }
  }

  async envKeys(app: string): Promise<string[]> {
    await this.assertApp(app);
    const secret = await this.readRuntimeEnv(app);
    return Object.keys(secret?.data ?? {}).sort();
  }

  async envSet(app: string, values: Record<string, string>): Promise<string[]> {
    await this.assertApp(app);
    const existing = await this.readRuntimeEnv(app);
    if (!existing) {
      await this.core.createNamespacedSecret({
        namespace: app,
        body: {
          metadata: { name: RUNTIME_ENV_SECRET, namespace: app, labels: { 'app.kubernetes.io/managed-by': FIELD_MANAGER } },
          type: 'Opaque',
          stringData: values,
        },
      });
    } else {
      await this.objects.patch(
        { apiVersion: 'v1', kind: 'Secret', metadata: { name: RUNTIME_ENV_SECRET, namespace: app }, stringData: values } as k8s.KubernetesObject,
        undefined,
        undefined,
        FIELD_MANAGER,
        undefined,
        k8s.PatchStrategy.MergePatch,
      );
    }
    return this.restart(app);
  }

  async envUnset(app: string, keys: string[]): Promise<string[]> {
    await this.assertApp(app);
    const existing = await this.readRuntimeEnv(app);
    const present = keys.filter((k) => existing?.data && k in existing.data);
    if (present.length === 0) return [];
    await this.objects.patch(
      {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: RUNTIME_ENV_SECRET, namespace: app },
        data: Object.fromEntries(present.map((k) => [k, null])),
      } as unknown as k8s.KubernetesObject,
      undefined,
      undefined,
      FIELD_MANAGER,
      undefined,
      k8s.PatchStrategy.MergePatch,
    );
    return this.restart(app);
  }

  async exec(app: string, command: string[], deployment?: string): Promise<ExecResult> {
    await this.assertApp(app);
    const pod = await this.podFor(app, deployment);
    const name = pod.metadata?.name ?? '';
    const container = pod.spec?.containers[0]?.name ?? '';
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = '';
    let err = '';
    const cap = 64 * 1024;
    stdout.on('data', (c: Buffer) => { if (out.length < cap) out += c.toString('utf8'); });
    stderr.on('data', (c: Buffer) => { if (err.length < cap) err += c.toString('utf8'); });
    const exitCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('command timed out after 120s')), 120_000);
      this.execApi
        .exec(app, name, container, command, stdout, stderr, null, false, (status) => {
          clearTimeout(timer);
          if (status.status === 'Success') return resolve(0);
          const cause = status.details?.causes?.find((c) => c.reason === 'ExitCode');
          resolve(cause?.message ? Number(cause.message) : 1);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error);
        });
    });
    return { pod: name, exitCode, stdout: out.slice(0, cap), stderr: err.slice(0, cap) };
  }

  async backupNow(): Promise<string> {
    const name = `${this.postgresCluster}-mcp-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`;
    await this.custom.createNamespacedCustomObject({
      group: 'postgresql.cnpg.io',
      version: 'v1',
      namespace: this.databaseNamespace,
      plural: 'backups',
      body: {
        apiVersion: 'postgresql.cnpg.io/v1',
        kind: 'Backup',
        metadata: { name, namespace: this.databaseNamespace },
        spec: {
          cluster: { name: this.postgresCluster },
          method: 'plugin',
          pluginConfiguration: { name: 'barman-cloud.cloudnative-pg.io' },
        },
      },
    });
    return name;
  }

  async listBackups(): Promise<BackupSummary[]> {
    const list = (await this.custom.listNamespacedCustomObject({
      group: 'postgresql.cnpg.io',
      version: 'v1',
      namespace: this.databaseNamespace,
      plural: 'backups',
    })) as { items: Array<Record<string, any>> };
    return list.items
      .map((b) => ({
        name: String(b.metadata?.name ?? ''),
        createdAt: String(b.metadata?.creationTimestamp ?? ''),
        phase: String(b.status?.phase ?? 'pending'),
        method: b.spec?.method,
        startedAt: b.status?.startedAt,
        stoppedAt: b.status?.stoppedAt,
        error: b.status?.error,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ createdAt, ...rest }) => ({ ...rest, createdAt }));
  }
}
