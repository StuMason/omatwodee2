/**
 * Cloudflare Access as the human login for /authorize.
 *
 * Only the /authorize path sits behind a Cloudflare Access application. When a
 * person reaches it, Access has already logged them in and adds a signed JWT in
 * the `Cf-Access-Jwt-Assertion` header. We verify that JWT ourselves (never
 * trust the header blindly): RS256 against the team's published keys, the
 * application's AUD tag, the team issuer, expiry, and an email allowlist.
 *
 * No secrets live here: the keys are public, the AUD tag identifies the app.
 */

import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';

export interface AccessConfig {
  /** e.g. "stumasondev.cloudflareaccess.com" */
  teamDomain: string;
  /** The Access application's Application Audience (AUD) tag. */
  audience: string;
  /** Lowercased emails allowed to authorize clients. */
  allowedEmails: string[];
}

export type AccessResult = { ok: true; email: string } | { ok: false; reason: string };

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
}

type FetchLike = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

const KEY_CACHE_MS = 60 * 60 * 1000;

function b64urlJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export class AccessVerifier {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;

  constructor(
    private readonly config: AccessConfig,
    private readonly fetchImpl: FetchLike = (url) => fetch(url, { signal: AbortSignal.timeout(10_000) }),
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async loadKeys(force: boolean): Promise<void> {
    if (!force && this.keys.size > 0 && this.now() - this.fetchedAt < KEY_CACHE_MS) return;
    const response = await this.fetchImpl(`https://${this.config.teamDomain}/cdn-cgi/access/certs`);
    if (!response.ok) throw new Error('could not fetch Cloudflare Access keys');
    const body = (await response.json()) as { keys?: Jwk[] };
    const keys = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) {
      if (jwk.kty !== 'RSA' || !jwk.kid) continue;
      keys.set(jwk.kid, createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }));
    }
    this.keys = keys;
    this.fetchedAt = this.now();
  }

  async verify(token: string | null | undefined): Promise<AccessResult> {
    if (!token) return { ok: false, reason: 'no Cloudflare Access login on this request' };
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = b64urlJson(headerPart);
      payload = b64urlJson(payloadPart);
    } catch {
      return { ok: false, reason: 'malformed token' };
    }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
      return { ok: false, reason: 'unexpected token algorithm' };
    }

    try {
      await this.loadKeys(false);
      if (!this.keys.has(header.kid)) await this.loadKeys(true);
    } catch {
      return { ok: false, reason: 'could not fetch Cloudflare Access keys' };
    }
    const key = this.keys.get(header.kid);
    if (!key) return { ok: false, reason: 'unknown signing key' };

    const valid = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${headerPart}.${payloadPart}`),
      key,
      Buffer.from(signaturePart, 'base64url'),
    );
    if (!valid) return { ok: false, reason: 'bad signature' };

    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(this.config.audience)) return { ok: false, reason: 'wrong audience' };
    if (payload.iss !== `https://${this.config.teamDomain}`) return { ok: false, reason: 'wrong issuer' };
    const nowSeconds = Math.floor(this.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp < nowSeconds) {
      return { ok: false, reason: 'login expired' };
    }
    if (typeof payload.nbf === 'number' && payload.nbf > nowSeconds + 60) {
      return { ok: false, reason: 'token not yet valid' };
    }

    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
    if (!email || !this.config.allowedEmails.includes(email)) {
      return { ok: false, reason: 'this account is not allowed to authorize clients' };
    }
    return { ok: true, email };
  }
}
