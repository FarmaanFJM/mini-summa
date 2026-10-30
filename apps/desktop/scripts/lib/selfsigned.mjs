// A throwaway self-signed TLS certificate, made with node:crypto and hand-written DER (no openssl needed). It exists only
// so that the smoke test can serve a local stand-in for chatgpt.com over https; the app accepts it through the
// MINISUMMA_TEST_TRUST_CERTS seam, for hosts that the test maps to loopback, and for nothing else.
import { X509Certificate, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const length = (n) => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const SEQUENCE = 0x30;
const SET = 0x31;
const INTEGER = 0x02;
const BIT_STRING = 0x03;
const OCTET_STRING = 0x04;
const OID = 0x06;
const UTF8_STRING = 0x0c;
const UTC_TIME = 0x17;
const BOOLEAN = 0x01;

const oid = (dotted) => {
  const arcs = dotted.split('.').map(Number);
  const out = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const stack = [arc & 0x7f];
    for (let v = arc >> 7; v > 0; v >>= 7) stack.unshift((v & 0x7f) | 0x80);
    out.push(...stack);
  }
  return der(OID, Buffer.from(out));
};
const utc = (date) => der(UTC_TIME, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`, 'ascii'));
const name = (cn) => der(SEQUENCE, der(SET, der(SEQUENCE, oid('2.5.4.3'), der(UTF8_STRING, Buffer.from(cn, 'utf8')))));
const extension = (id, critical, value) => der(SEQUENCE, oid(id), ...(critical ? [der(BOOLEAN, Buffer.from([0xff]))] : []), der(OCTET_STRING, value));
const pem = (label, buf) => `-----BEGIN ${label}-----\n${buf.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END ${label}-----\n`;

/** @param {string[]} hosts DNS names the certificate is valid for (the first is also the common name). */
export function makeSelfSigned(hosts) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sigAlg = der(SEQUENCE, oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const serial = randomBytes(8);
  serial[0] &= 0x7f;
  serial[0] |= 0x01; // positive, and never a leading zero byte
  const now = Date.now();
  const tbs = der(
    SEQUENCE,
    der(0xa0, der(INTEGER, Buffer.from([2]))), // version 3
    der(INTEGER, serial),
    sigAlg,
    name(hosts[0]), // issuer: self-signed, so issuer and subject are the same name
    der(SEQUENCE, utc(new Date(now - 24 * 3600e3)), utc(new Date(now + 7 * 24 * 3600e3))),
    name(hosts[0]),
    publicKey.export({ type: 'spki', format: 'der' }),
    der(
      0xa3,
      der(
        SEQUENCE,
        extension('2.5.29.17', false, der(SEQUENCE, ...hosts.map((h) => der(0x82, Buffer.from(h, 'ascii'))))), // subjectAltName
        extension('2.5.29.19', true, der(SEQUENCE)), // basicConstraints: not a CA
        extension('2.5.29.15', true, der(BIT_STRING, Buffer.from([0x07, 0x80]))), // keyUsage: digitalSignature
        extension('2.5.29.37', false, der(SEQUENCE, oid('1.3.6.1.5.5.7.3.1'))), // extKeyUsage: serverAuth
      ),
    ),
  );
  const signature = sign('sha256', tbs, privateKey);
  const certDer = der(SEQUENCE, tbs, sigAlg, der(BIT_STRING, Buffer.concat([Buffer.from([0]), signature])));
  const cert = pem('CERTIFICATE', certDer);
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' });
  // Fail here, not in the browser, if the hand-made certificate is malformed.
  const parsed = new X509Certificate(cert);
  if (!parsed.verify(publicKey)) throw new Error('self-signed certificate does not verify against its own key');
  for (const host of hosts) if (!parsed.checkHost(host)) throw new Error(`certificate does not cover ${host}`);
  return { key, cert };
}
