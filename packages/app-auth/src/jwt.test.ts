import * as jwt from 'jsonwebtoken';

import { decodeJwt } from './jwt';

describe('decodeJwt', () => {
  const secret = 'test-secret';

  it('decodes a valid JWT', () => {
    const token = jwt.sign(
      { sub: 'user-123', appId: 'my-app', accountId: 'acct-1', sessionId: 'sess-1' },
      secret,
      { algorithm: 'HS256', expiresIn: '24h' },
    );

    const result = decodeJwt(token);

    expect(result.sub).toBe('user-123');
    expect(result.appId).toBe('my-app');
    expect(result.accountId).toBe('acct-1');
    expect(result.sessionId).toBe('sess-1');
    expect(result.iat).toBeDefined();
    expect(result.exp).toBeDefined();
  });

  it('throws on invalid JWT format (no dots)', () => {
    expect(() => decodeJwt('not-a-jwt')).toThrow('Invalid JWT format');
  });

  it('throws on malformed payload', () => {
    // Header.Payload.Signature — payload is not valid base64 JSON
    expect(() => decodeJwt('header.!!!invalid!!!.signature')).toThrow();
  });

  it('decodes without verifying signature', () => {
    // Create a valid JWT then tamper the signature
    const token = jwt.sign({ sub: 'user', appId: 'app', accountId: 'acct', sessionId: 'sess' }, secret);
    const [header, payload] = token.split('.');
    const tampered = `${header}.${payload}.tampered-signature`;

    // Should still decode (no verification)
    const result = decodeJwt(tampered);
    expect(result.sub).toBe('user');
  });

  it('handles base64url padding correctly', () => {
    // Payload that would need padding
    const token = jwt.sign(
      { sub: 'a', appId: 'b', accountId: 'c', sessionId: 'd' },
      secret,
    );

    const result = decodeJwt(token);
    expect(result.sub).toBe('a');
  });
});
