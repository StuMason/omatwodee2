import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { AccessVerifier, type AccessConfig } from '../lib/access.js';

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'aud-tag-123';
const NOW = 1_800_000_000_000;

function keypair(kid: string): { kid: string; priv: KeyObject; jwk: Record<string, unknown> } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, priv: privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid } };
}

function jwt(priv: KeyObject, kid: string, claims: Record<string, unknown>, alg = 'RS256'): string {
  const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg, kid, typ: 'JWT' });
  const body = enc(claims);
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), priv).toString('base64url');
  return `${head}.${body}.${sig}`;
}

const good = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  aud: [AUD],
  iss: `https://${TEAM}`,
  email: 'Stu@Example.com',
  exp: NOW / 1000 + 600,
  iat: NOW / 1000,
  ...extra,
});

describe('AccessVerifier', () => {
  const k1 = keypair('k1');
  const config: AccessConfig = { teamDomain: TEAM, audience: AUD, allowedEmails: ['stu@example.com'] };
  let served: Array<Record<string, unknown>>;
  let fetches: number;
  const fetchImpl = async (url: string): Promise<{ ok: boolean; json: () => Promise<unknown> }> => {
    fetches += 1;
    expect(url).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
    return { ok: true, json: async () => ({ keys: served }) };
  };
  const make = (): AccessVerifier => new AccessVerifier(config, fetchImpl, () => NOW);

  beforeEach(() => {
    served = [k1.jwk];
    fetches = 0;
  });

  it('accepts a valid token and returns the lowercased email', async () => {
    expect(await make().verify(jwt(k1.priv, 'k1', good()))).toEqual({ ok: true, email: 'stu@example.com' });
  });

  it('rejects a missing token', async () => {
    expect((await make().verify(null)).ok).toBe(false);
  });

  it('rejects a token signed by another key with the same kid', async () => {
    const forger = keypair('k1');
    const result = await make().verify(jwt(forger.priv, 'k1', good()));
    expect(result).toEqual({ ok: false, reason: 'bad signature' });
  });

  it('rejects alg none and other algorithms', async () => {
    const result = await make().verify(jwt(k1.priv, 'k1', good(), 'none'));
    expect(result).toEqual({ ok: false, reason: 'unexpected token algorithm' });
  });

  it('rejects the wrong audience, issuer and expired tokens', async () => {
    const v = make();
    expect(await v.verify(jwt(k1.priv, 'k1', good({ aud: ['other'] })))).toEqual({ ok: false, reason: 'wrong audience' });
    expect(await v.verify(jwt(k1.priv, 'k1', good({ iss: 'https://evil.cloudflareaccess.com' })))).toEqual({ ok: false, reason: 'wrong issuer' });
    expect(await v.verify(jwt(k1.priv, 'k1', good({ exp: NOW / 1000 - 1 })))).toEqual({ ok: false, reason: 'login expired' });
  });

  it('rejects an email that is not on the allowlist', async () => {
    const result = await make().verify(jwt(k1.priv, 'k1', good({ email: 'someone@else.com' })));
    expect(result.ok).toBe(false);
  });

  it('rejects malformed tokens', async () => {
    expect(await make().verify('not.a')).toEqual({ ok: false, reason: 'malformed token' });
    expect(await make().verify('###.###.###')).toEqual({ ok: false, reason: 'malformed token' });
  });

  it('caches keys and refetches once when a new kid appears (key rotation)', async () => {
    const v = make();
    await v.verify(jwt(k1.priv, 'k1', good()));
    await v.verify(jwt(k1.priv, 'k1', good()));
    expect(fetches).toBe(1);
    const k2 = keypair('k2');
    served = [k1.jwk, k2.jwk];
    expect((await v.verify(jwt(k2.priv, 'k2', good()))).ok).toBe(true);
    expect(fetches).toBe(2);
    expect(await v.verify(jwt(k2.priv, 'k3', good()))).toEqual({ ok: false, reason: 'unknown signing key' });
  });

  it('fails closed when the keys cannot be fetched', async () => {
    const v = new AccessVerifier(config, async () => ({ ok: false, json: async () => ({}) }), () => NOW);
    expect(await v.verify(jwt(k1.priv, 'k1', good()))).toEqual({ ok: false, reason: 'could not fetch Cloudflare Access keys' });
  });
});

import { cpu, memory } from '../lib/cluster.js';
describe('quantity formatting', () => {
  it('formats CPU as millicores', () => {
    expect(cpu('152839126n')).toBe('153m');
    expect(cpu('2500u')).toBe('3m');
    expect(cpu('250m')).toBe('250m');
    expect(cpu('2')).toBe('2000m');
  });
  it('formats memory as Mi/Gi', () => {
    expect(memory('2658000Ki')).toBe('2.5Gi');
    expect(memory('142776Ki')).toBe('139Mi');
    expect(memory('512Mi')).toBe('512Mi');
  });
});
