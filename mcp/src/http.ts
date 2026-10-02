#!/usr/bin/env node
/**
 * Entry point: remote MCP over Streamable HTTP with OAuth 2.1, running in the
 * cluster as the or2-agent ServiceAccount. The Node <-> fetch adapter is
 * forked from coolify-mcp (MIT, (c) Stu Mason).
 *
 * Env:
 *   MCP_PUBLIC_URL          https://mcp-or2.example.com (required, https)
 *   CF_ACCESS_TEAM_DOMAIN   e.g. yourteam.cloudflareaccess.com (required)
 *   CF_ACCESS_AUD           AUD tag of the Access app on /authorize (required)
 *   OR2_ALLOWED_EMAILS      comma-separated emails allowed to authorize (required)
 *   MCP_OAUTH_STATE_FILE    default /data/oauth-state.json (OAuth artefacts only)
 *   PORT                    default 8080
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as k8s from '@kubernetes/client-node';
import { AccessVerifier } from './lib/access.js';
import { K8sCluster } from './lib/cluster.js';
import { createHttpApp, normalizePublicUrl } from './lib/http-server.js';

const MAX_BODY_BYTES = 1024 * 1024;
class BodyTooLarge extends Error {}

async function toRequest(req: IncomingMessage, base: string): Promise<Request> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);
  return new Request(`${base}${req.url ?? '/'}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([key, value]) =>
      value === undefined ? [] : Array.isArray(value) ? value.map((v) => [key, v] as [string, string]) : [[key, value] as [string, string]],
    ),
    body: body.length > 0 ? body : undefined,
  });
}

async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}

function main(): void {
  const problems: string[] = [];
  const env = process.env;
  let publicUrl = '';
  try {
    publicUrl = normalizePublicUrl(env.MCP_PUBLIC_URL ?? '');
    if (!publicUrl.startsWith('https://') && env.MCP_ALLOW_INSECURE_HTTP !== 'true') {
      problems.push(`MCP_PUBLIC_URL must be https (got ${publicUrl})`);
    }
  } catch {
    problems.push('MCP_PUBLIC_URL is not set or not a URL, e.g. https://mcp-or2.example.com');
  }
  const teamDomain = (env.CF_ACCESS_TEAM_DOMAIN ?? '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const audience = (env.CF_ACCESS_AUD ?? '').trim();
  const allowedEmails = (env.OR2_ALLOWED_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!teamDomain) problems.push('CF_ACCESS_TEAM_DOMAIN is not set, e.g. yourteam.cloudflareaccess.com');
  if (!audience) problems.push('CF_ACCESS_AUD is not set: the AUD tag of the Access app protecting /authorize');
  if (allowedEmails.length === 0) problems.push('OR2_ALLOWED_EMAILS is not set: who may authorize clients');
  if (problems.length > 0) {
    console.error('omatwodee2-mcp cannot start:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const kc = new k8s.KubeConfig();
  if (env.KUBERNETES_SERVICE_HOST) kc.loadFromCluster();
  else kc.loadFromDefault();

  const verifier = new AccessVerifier({ teamDomain, audience, allowedEmails });
  const app = createHttpApp({
    publicUrl,
    accessTokenTtl: Number(env.MCP_ACCESS_TOKEN_TTL || 3600),
    refreshTokenTtl: Number(env.MCP_REFRESH_TOKEN_TTL || 28_800),
    stateFile: env.MCP_OAUTH_STATE_FILE || '/data/oauth-state.json',
    cluster: new K8sCluster(kc),
    verifyAccess: (jwt) => verifier.verify(jwt),
  });

  const server = createServer((req, res) => {
    toRequest(req, publicUrl)
      .then((request) => app.fetch(request))
      .then((response) => writeResponse(response, res))
      .catch((error: unknown) => {
        if (error instanceof BodyTooLarge) {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'payload_too_large' }));
          req.destroy();
          return;
        }
        console.error('http:', error instanceof Error ? error.message : String(error));
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error' }));
      });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;

  const port = Number(env.PORT || 8080);
  server.listen(port, () => console.error(`omatwodee2-mcp on :${port} (public: ${publicUrl})`));

  const shutdown = (): void => {
    app.provider.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
