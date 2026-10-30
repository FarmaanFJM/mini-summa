import { X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// The smoke test's certificate helper: plain JavaScript, no declarations.
// @ts-ignore -- no declaration file for a .mjs helper
import { makeSelfSigned } from '../../scripts/lib/selfsigned.mjs';

describe('the throw-away certificate of the local stand-ins', () => {
  // The certificate's size varies with the signature. For two host names it is often exactly 512 base64 characters, a multiple
  // of 64, and the PEM writer used to leave an empty line before the END marker, which OpenSSL refuses. It failed about three
  // times in four, so a few dozen attempts cannot pass by luck.
  it('is always a valid certificate for the host names it was made for, however long it comes out', () => {
    for (const hosts of [['chatgpt.com'], ['claude.ai'], ['chatgpt.com', 'claude.ai']]) {
      for (let i = 0; i < 40; i += 1) {
        const { cert } = makeSelfSigned(hosts) as { key: string; cert: string };
        expect(cert).not.toMatch(/\n\n/);
        const parsed = new X509Certificate(cert);
        for (const host of hosts) expect(parsed.checkHost(host)).toBeTruthy();
      }
    }
  });
});
