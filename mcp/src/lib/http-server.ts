/**
 * Streamable HTTP + OAuth 2.1 router. Adapted from coolify-mcp's http-server
 * (MIT, (c) Stu Mason): same routes, rate limits and OAuth wiring. The one
 * change is the human proof at /authorize: instead of a pasted Coolify token,
 * the person must already be logged in through Cloudflare Access (only the
 * /authorize path is behind Access), and we verify Access's signed JWT on both
 * the GET (consent page) and the POST (approval).
 *
 * The client only ever receives a short-lived, audience-bound MCP token. It
 * never sees a Kubernetes or Cloudflare credential: the server acts with its
 * own ServiceAccount.
 */

import { createMcpHandler, requireBearerAuth, type McpHttpHandler } from '@modelcontextprotocol/server';
import { OAuthProvider, OAuthErrorResponse, isClientIdUrl } from './oauth.js';
import type { AccessResult } from './access.js';
import type { Cluster } from './cluster.js';
import { Or2McpServer } from './server.js';

export interface HttpServerConfig {
  publicUrl: string;
  accessTokenTtl: number;
  refreshTokenTtl: number;
  stateFile: string;
  cluster: Cluster;
  verifyAccess: (jwt: string | null) => Promise<AccessResult>;
}

export function normalizePublicUrl(raw: string): string {
  let value = raw.trim();
  if (value === '') throw new Error('empty URL');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`unsupported protocol: ${url.protocol}`);
  if (!url.hostname) throw new Error('no hostname');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** Fixed-window per-IP limiter for the endpoints that take guesses. */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}
  allow(key: string): boolean {
    const now = Date.now();
    const window = this.windows.get(key);
    if (!window || window.resetAt < now) {
      if (this.windows.size > 10_000) {
        for (const [k, w] of this.windows) if (w.resetAt < now) this.windows.delete(k);
      }
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    window.count += 1;
    return window.count <= this.limit;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    },
  });
}
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const STYLE = `body{font-family:system-ui,sans-serif;max-width:26rem;margin:12vh auto;padding:0 1rem;color:#1a1a1a}
h1{font-size:1.2rem}p{line-height:1.5;color:#444}.who{font-size:.9rem;color:#666}
button{margin-top:1rem;width:100%;padding:.7rem;font-size:1rem;border:0;border-radius:6px;background:#0f5c4d;color:#fff;cursor:pointer}
.error{background:#fde8e8;border:1px solid #f5b5b5;border-radius:6px;padding:.6rem .8rem;color:#8a1f1f}`;

function consentPage(params: URLSearchParams, clientName: string, email: string, host: string): string {
  const hidden = [...params.entries()]
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join('\n    ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize ${escapeHtml(clientName)}</title><style>${STYLE}</style></head><body>
<h1>Authorize ${escapeHtml(clientName)}</h1>
<p><strong>${escapeHtml(clientName)}</strong> wants to operate the apps on <strong>${escapeHtml(host)}</strong>: read status and logs, restart, change env values, run commands and take backups.</p>
<p class="who">Signed in through Cloudflare Access as ${escapeHtml(email)}.</p>
<form method="post" action="authorize">
    ${hidden}
    <button type="submit">Approve</button>
</form></body></html>`;
}

function deniedPage(reason: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not authorized</title><style>${STYLE}</style></head><body>
<h1>Not authorized</h1><p class="error">${escapeHtml(reason)}</p>
<p>This page only works when you reach it through Cloudflare Access with an allowed account.</p></body></html>`;
}

export function createHttpApp(config: HttpServerConfig): { fetch: (request: Request) => Promise<Response>; provider: OAuthProvider } {
  const publicUrl = config.publicUrl.replace(/\/$/, '');
  const resourceUrl = `${publicUrl}/mcp`;
  const host = new URL(publicUrl).host;

  const provider = new OAuthProvider({
    issuer: publicUrl,
    resource: resourceUrl,
    accessTokenTtl: config.accessTokenTtl,
    refreshTokenTtl: config.refreshTokenTtl,
    stateFile: config.stateFile,
  });

  const bearer = requireBearerAuth({
    verifier: { verifyAccessToken: (token) => provider.verifyAccessToken(token) },
    resourceMetadataUrl: `${publicUrl}/.well-known/oauth-protected-resource`,
  });

  const mcpHandler: McpHttpHandler = createMcpHandler(() => new Or2McpServer(config.cluster), {
    onerror: (error) => console.error('mcp handler:', error.message),
  });

  const authLimiter = new RateLimiter(20, 60_000);

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    // Behind Cloudflare: cf-connecting-ip is the visitor; fall back to XFF.
    const clientIp =
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      'local';

    if (path === '/healthz') {
      return json(provider.persistenceDegraded ? { status: 'ok', persistence: 'degraded' } : { status: 'ok' });
    }
    if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
      return json(provider.protectedResourceMetadata());
    }
    if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/oauth-authorization-server/mcp') {
      return json(provider.authorizationServerMetadata());
    }

    if (path === '/register' && request.method === 'POST') {
      if (!authLimiter.allow(`reg:${clientIp}`)) return json({ error: 'too_many_requests' }, 429);
      try {
        return json(provider.registerClient((await request.json()) as Record<string, unknown>), 201);
      } catch (error) {
        if (error instanceof OAuthErrorResponse) return json({ error: error.code, error_description: error.description }, error.status);
        return json({ error: 'invalid_client_metadata' }, 400);
      }
    }

    if (path === '/authorize' && (request.method === 'GET' || request.method === 'POST')) {
      if (request.method === 'POST' && !authLimiter.allow(`auth:${clientIp}`)) {
        return html('<p>Too many attempts. Try again in a minute.</p>', 429);
      }
      const params = request.method === 'GET' ? url.searchParams : new URLSearchParams(await request.text());
      const clientId = params.get('client_id') ?? '';
      if (request.method === 'GET' && isClientIdUrl(clientId) && !authLimiter.allow(`cimd:${clientIp}`)) {
        return html('<p>Too many attempts. Try again in a minute.</p>', 429);
      }

      const access = await config.verifyAccess(request.headers.get('cf-access-jwt-assertion'));
      if (!access.ok) return html(deniedPage(access.reason), 403);

      let validated;
      try {
        await provider.resolveClient(clientId);
        validated = provider.validateAuthorizationRequest(params);
      } catch (error) {
        if (error instanceof OAuthErrorResponse) {
          return html(`<p>Authorization request rejected: ${escapeHtml(error.description)}</p>`, 400);
        }
        throw error;
      }
      if (request.method === 'GET') {
        return html(consentPage(params, validated.client.client_name ?? 'An MCP client', access.email, host));
      }
      process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event: 'authorized', client: validated.client.client_id, by: access.email })}\n`);
      const { redirectTo } = provider.completeAuthorization(validated);
      return new Response(null, { status: 302, headers: { location: redirectTo, 'cache-control': 'no-store' } });
    }

    if (path === '/token' && request.method === 'POST') {
      if (!authLimiter.allow(`token:${clientIp}`)) return json({ error: 'too_many_requests' }, 429);
      try {
        const body = new URLSearchParams(await request.text());
        await provider.resolveClient(body.get('client_id') ?? '');
        return json(provider.exchange(body));
      } catch (error) {
        if (error instanceof OAuthErrorResponse) return json({ error: error.code, error_description: error.description }, error.status);
        throw error;
      }
    }

    if (path === '/mcp') {
      const authResult = await bearer(request);
      if (authResult instanceof Response) return authResult;
      return mcpHandler.fetch(request, { authInfo: authResult });
    }

    return json({ error: 'not_found' }, 404);
  }

  return { fetch: handle, provider };
}
