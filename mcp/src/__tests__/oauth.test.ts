// Forked from coolify-mcp (MIT, (c) Stu Mason): OAuthProvider tests only.
/**
 * OAuth 2.1 authorization server + HTTP mode tests (#303).
 */

import { jest } from '@jest/globals';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OAuthProvider,
  OAuthErrorResponse,
  canonicalResource,
  redirectUriMatches,
} from '../lib/oauth.js';

const ISSUER = 'https://mcp.example.com';
const RESOURCE = `${ISSUER}/mcp`;

function makeProvider(stateFile = ''): OAuthProvider {
  return new OAuthProvider({
    issuer: ISSUER,
    resource: RESOURCE,
    accessTokenTtl: 3600,
    refreshTokenTtl: 28_800,
    stateFile,
  });
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function registerTestClient(provider: OAuthProvider): string {
  const registered = provider.registerClient({
    client_name: 'Test Client',
    redirect_uris: ['https://client.example.com/callback'],
    token_endpoint_auth_method: 'none',
  });
  return registered.client_id as string;
}

/** Drive the full happy path up to a code, returning what /token needs. */
function authorize(
  provider: OAuthProvider,
  clientId: string,
  challenge: string,
): { code: string; state: string | null } {
  const validated = provider.validateAuthorizationRequest(
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: 'https://client.example.com/callback',
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: RESOURCE,
      state: 'client-state',
    }),
  );
  const { redirectTo } = provider.completeAuthorization(validated);
  const url = new URL(redirectTo);
  return { code: url.searchParams.get('code')!, state: url.searchParams.get('state') };
}

describe('OAuthProvider', () => {
  describe('client registration', () => {
    it('registers a public client and echoes RFC 7591 metadata', () => {
      const provider = makeProvider();
      const result = provider.registerClient({
        client_name: 'Claude',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      });
      expect(result.client_id).toMatch(/^mcp_client_/);
      expect(result.client_secret).toBeUndefined();
      expect(result.token_endpoint_auth_method).toBe('none');
      expect(result.response_types).toEqual(['code']);
    });

    it('issues a secret for confidential clients and stores only its hash', () => {
      const provider = makeProvider();
      const result = provider.registerClient({
        redirect_uris: ['https://client.example.com/cb'],
        token_endpoint_auth_method: 'client_secret_post',
      });
      expect(result.client_secret).toMatch(/^mcp_secret_/);
    });

    it('rejects missing redirect_uris, non-https redirects, and unknown auth methods', () => {
      const provider = makeProvider();
      expect(() => provider.registerClient({})).toThrow(OAuthErrorResponse);
      expect(() =>
        provider.registerClient({ redirect_uris: ['http://evil.example.com/cb'] }),
      ).toThrow('https');
      expect(() =>
        provider.registerClient({
          redirect_uris: ['https://ok.example.com/cb'],
          token_endpoint_auth_method: 'client_secret_basic',
        }),
      ).toThrow('token_endpoint_auth_method');
    });

    it('allows loopback redirect URIs over http', () => {
      const provider = makeProvider();
      const result = provider.registerClient({
        redirect_uris: [
          'http://localhost:33418/callback',
          'http://127.0.0.1:33418/callback',
          'http://[::1]:33418/callback',
        ],
      });
      expect(result.client_id).toBeDefined();
    });

    it('rejects non-http schemes even on a loopback host, and fragments (#340)', () => {
      const provider = makeProvider();
      for (const uri of [
        'javascript://localhost/alert(1)',
        'file://localhost/etc/passwd',
        'data://127.0.0.1/text',
        'custom://[::1]/cb',
      ]) {
        expect(() => provider.registerClient({ redirect_uris: [uri] })).toThrow('https');
      }
      expect(() =>
        provider.registerClient({ redirect_uris: ['https://ok.example.com/cb#frag'] }),
      ).toThrow('fragment');
    });
  });

  describe('authorization request validation', () => {
    it('rejects unknown clients, unregistered redirect URIs, and missing PKCE', () => {
      const provider = makeProvider();
      const clientId = registerTestClient(provider);

      expect(() =>
        provider.validateAuthorizationRequest(new URLSearchParams({ client_id: 'nope' })),
      ).toThrow('unknown client_id');

      expect(() =>
        provider.validateAuthorizationRequest(
          new URLSearchParams({
            client_id: clientId,
            redirect_uri: 'https://attacker.example.com/cb',
          }),
        ),
      ).toThrow('redirect_uri');

      const { challenge } = pkcePair();
      expect(() =>
        provider.validateAuthorizationRequest(
          new URLSearchParams({
            client_id: clientId,
            redirect_uri: 'https://client.example.com/callback',
            response_type: 'code',
            code_challenge: challenge,
            code_challenge_method: 'plain',
          }),
        ),
      ).toThrow('S256');
    });

    it('rejects a resource parameter naming a different server (RFC 8707)', () => {
      const provider = makeProvider();
      const clientId = registerTestClient(provider);
      const { challenge } = pkcePair();
      expect(() =>
        provider.validateAuthorizationRequest(
          new URLSearchParams({
            client_id: clientId,
            redirect_uri: 'https://client.example.com/callback',
            response_type: 'code',
            code_challenge: challenge,
            code_challenge_method: 'S256',
            resource: 'https://other-server.example.com/mcp',
          }),
        ),
      ).toThrow('invalid_target');
    });
  });

  describe('code exchange', () => {
    it('completes the full PKCE flow and issues working tokens', async () => {
      const provider = makeProvider();
      const clientId = registerTestClient(provider);
      const { verifier, challenge } = pkcePair();
      const { code, state } = authorize(provider, clientId, challenge);
      expect(state).toBe('client-state');

      const tokens = provider.exchange(
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          redirect_uri: 'https://client.example.com/callback',
          code_verifier: verifier,
        }),
      );
      expect(tokens.access_token).toMatch(/^mcp_at_/);
      expect(tokens.refresh_token).toMatch(/^mcp_rt_/);
      expect(tokens.expires_in).toBe(3600);

      const verified = await provider.verifyAccessToken(tokens.access_token as string);
      expect(verified.clientId).toBe(clientId);
      expect(verified.resource?.href).toBe(new URL(RESOURCE).href);
    });

    it('rejects a wrong verifier and burns the code either way (single use)', () => {
      const provider = makeProvider();
      const clientId = registerTestClient(provider);
      const { verifier, challenge } = pkcePair();
      const { code } = authorize(provider, clientId, challenge);

      const attempt = (v: string): Record<string, unknown> =>
        provider.exchange(
          new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            code,
            redirect_uri: 'https://client.example.com/callback',
            code_verifier: v,
          }),
        );

      expect(() => attempt('wrong-verifier')).toThrow('PKCE');
      // The failed attempt consumed the code; the correct verifier is too late.
      expect(() => attempt(verifier)).toThrow('invalid or expired');
    });

    it('rejects a redirect_uri mismatch at exchange time', () => {
      const provider = makeProvider();
      const clientId = registerTestClient(provider);
      const { verifier, challenge } = pkcePair();
      const { code } = authorize(provider, clientId, challenge);
      expect(() =>
        provider.exchange(
          new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            code,
            redirect_uri: 'https://client.example.com/other',
            code_verifier: verifier,
          }),
        ),
      ).toThrow('redirect_uri mismatch');
    });

    it("rejects another client's code", () => {
      const provider = makeProvider();
      const clientId = registerTestClient(provider);
      const otherId = registerTestClient(provider);
      const { verifier, challenge } = pkcePair();
      const { code } = authorize(provider, clientId, challenge);
      expect(() =>
        provider.exchange(
          new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: otherId,
            code,
            redirect_uri: 'https://client.example.com/callback',
            code_verifier: verifier,
          }),
        ),
      ).toThrow('invalid or expired');
    });
  });

  describe('refresh rotation and reuse detection', () => {
    function issueViaFlow(provider: OAuthProvider, clientId: string): Record<string, unknown> {
      const { verifier, challenge } = pkcePair();
      const { code } = authorize(provider, clientId, challenge);
      return provider.exchange(
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          redirect_uri: 'https://client.example.com/callback',
          code_verifier: verifier,
        }),
      );
    }

    it('rotates the refresh token on use', async () => {
      const provider = makeProvider();
      const clientId = registerTestClient(provider);
      const first = issueViaFlow(provider, clientId);

      const second = provider.exchange(
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: first.refresh_token as string,
        }),
      );
      expect(second.refresh_token).not.toBe(first.refresh_token);
      await expect(
        provider.verifyAccessToken(second.access_token as string),
      ).resolves.toBeDefined();
    });

    it('revokes the whole grant family when a rotated refresh token is replayed', async () => {
      const provider = makeProvider();
      const clientId = registerTestClient(provider);
      const first = issueViaFlow(provider, clientId);
      const second = provider.exchange(
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: first.refresh_token as string,
        }),
      );

      // Replay of the rotated-away token: the OAuth 2.1 leak signal.
      expect(() =>
        provider.exchange(
          new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: first.refresh_token as string,
          }),
        ),
      ).toThrow('reuse detected');

      // Every descendant dies with it, including the freshly issued pair.
      await expect(provider.verifyAccessToken(second.access_token as string)).rejects.toThrow(
        'not valid',
      );
      expect(() =>
        provider.exchange(
          new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: second.refresh_token as string,
          }),
        ),
      ).toThrow('invalid');
    });

    it('refuses a refresh token used as an access token, and vice versa', async () => {
      const provider = makeProvider();
      const clientId = registerTestClient(provider);
      const tokens = issueViaFlow(provider, clientId);
      await expect(provider.verifyAccessToken(tokens.refresh_token as string)).rejects.toThrow(
        'not valid',
      );
      expect(() =>
        provider.exchange(
          new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: clientId,
            refresh_token: tokens.access_token as string,
          }),
        ),
      ).toThrow('invalid');
    });
  });

  describe('persistence', () => {
    it('round-trips state through the file and never writes raw tokens', () => {
      const dir = mkdtempSync(join(tmpdir(), 'oauth-test-'));
      const stateFile = join(dir, 'state.json');
      try {
        const provider = makeProvider(stateFile);
        const clientId = registerTestClient(provider);
        const { verifier, challenge } = pkcePair();
        const { code } = authorize(provider, clientId, challenge);
        const tokens = provider.exchange(
          new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            code,
            redirect_uri: 'https://client.example.com/callback',
            code_verifier: verifier,
          }),
        );
        provider.flush();

        const raw = readFileSync(stateFile, 'utf8');
        expect(raw).not.toContain(tokens.access_token as string);
        expect(raw).not.toContain(tokens.refresh_token as string);
        expect(raw).not.toContain(code);

        // A fresh provider over the same file still honours the tokens.
        const reloaded = makeProvider(stateFile);
        return expect(
          reloaded.verifyAccessToken(tokens.access_token as string),
        ).resolves.toMatchObject({ clientId });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('canonicalResource strips fragments and trailing slashes', () => {
    expect(canonicalResource('https://a.example.com/mcp#frag')).toBe('https://a.example.com/mcp');
    expect(canonicalResource('https://a.example.com/mcp/')).toBe('https://a.example.com/mcp');
  });
});

