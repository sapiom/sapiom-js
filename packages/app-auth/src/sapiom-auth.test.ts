import * as jwt from 'jsonwebtoken';

import { SapiomAuth } from './sapiom-auth';

describe('SapiomAuth', () => {
  const config = {
    appId: 'repo-analyzer',
    appUuid: 'abc-123-def',
    gatewayUrl: 'https://auth0.x402.sapiom.ai',
    jwtSecret: 'test-jwt-secret-for-hs256-signing-key!',
  };

  let auth: SapiomAuth;

  beforeEach(() => {
    auth = new SapiomAuth(config);
  });

  // ─── URL builders ───

  describe('getLoginUrl', () => {
    it('returns correct login URL', () => {
      expect(auth.getLoginUrl()).toBe(
        'https://auth0.x402.sapiom.ai/auth/abc-123-def/login',
      );
    });

    it('strips trailing slash from gatewayUrl', () => {
      const a = new SapiomAuth({ ...config, gatewayUrl: 'https://example.com/' });
      expect(a.getLoginUrl()).toBe('https://example.com/auth/abc-123-def/login');
    });
  });

  describe('getConnectUrl', () => {
    it('returns correct connect URL with session token', () => {
      const url = auth.getConnectUrl('github', 'my-token');
      expect(url).toBe(
        'https://auth0.x402.sapiom.ai/auth/abc-123-def/connect/github?session_token=my-token',
      );
    });
  });

  describe('getLogoutUrl', () => {
    it('returns correct logout URL', () => {
      const url = auth.getLogoutUrl('my-token');
      expect(url).toBe(
        'https://auth0.x402.sapiom.ai/auth/abc-123-def/logout?session_token=my-token',
      );
    });
  });

  // ─── decodeSession ───

  describe('decodeSession', () => {
    it('decodes a JWT session token', () => {
      const token = jwt.sign(
        { sub: 'user-1', appId: 'repo-analyzer', accountId: 'acct-1', sessionId: 'sess-1' },
        config.jwtSecret!,
        { algorithm: 'HS256' },
      );

      const user = auth.decodeSession(token);
      expect(user.sub).toBe('user-1');
      expect(user.appId).toBe('repo-analyzer');
    });
  });

  // ─── getUser (server-side JWT verify) ───

  describe('getUser', () => {
    it('verifies a valid session token', async () => {
      const token = jwt.sign(
        { sub: 'user-1', appId: 'repo-analyzer', accountId: 'acct-1', sessionId: 'sess-1' },
        config.jwtSecret!,
        { algorithm: 'HS256', expiresIn: '24h' },
      );

      const user = await auth.getUser(token);

      expect(user.sub).toBe('user-1');
      expect(user.appId).toBe('repo-analyzer');
      expect(user.accountId).toBe('acct-1');
    });

    it('throws when session token is empty', async () => {
      await expect(auth.getUser('')).rejects.toThrow('sessionToken is required');
    });

    it('throws when jwtSecret is not configured', async () => {
      const noSecretAuth = new SapiomAuth({ ...config, jwtSecret: undefined });
      const token = jwt.sign(
        { sub: 'user-1', appId: 'repo-analyzer', accountId: 'acct-1', sessionId: 'sess-1' },
        'any-secret',
      );

      await expect(noSecretAuth.getUser(token)).rejects.toThrow('jwtSecret is required');
    });

    it('throws when token was signed for a different app', async () => {
      const token = jwt.sign(
        { sub: 'user-1', appId: 'different-app', accountId: 'acct-1', sessionId: 'sess-1' },
        config.jwtSecret!,
        { algorithm: 'HS256', expiresIn: '24h' },
      );

      await expect(auth.getUser(token)).rejects.toThrow('different app');
    });

    it('throws when token is expired', async () => {
      const token = jwt.sign(
        { sub: 'user-1', appId: 'repo-analyzer', accountId: 'acct-1', sessionId: 'sess-1' },
        config.jwtSecret!,
        { algorithm: 'HS256', expiresIn: '-1s' },
      );

      await expect(auth.getUser(token)).rejects.toThrow();
    });

    it('throws when token has wrong signature', async () => {
      const token = jwt.sign(
        { sub: 'user-1', appId: 'repo-analyzer', accountId: 'acct-1', sessionId: 'sess-1' },
        'wrong-secret',
        { algorithm: 'HS256', expiresIn: '24h' },
      );

      await expect(auth.getUser(token)).rejects.toThrow();
    });
  });

  // ─── getConnection / listConnections (x402-gated) ───

  describe('getConnection', () => {
    it('throws when session token is empty', async () => {
      await expect(auth.getConnection('', 'github')).rejects.toThrow('sessionToken is required');
    });
  });

  describe('listConnections', () => {
    it('throws when session token is empty', async () => {
      await expect(auth.listConnections('')).rejects.toThrow('sessionToken is required');
    });
  });
});
