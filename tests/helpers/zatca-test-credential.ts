/**
 * A throwaway ZATCA-shaped signing credential for tests: a fresh secp256k1 key and a
 * self-signed X.509 certificate built at run time, so no key material is committed.
 * Uses @noble/curves because Electron's BoringSSL has no secp256k1.
 */
import crypto from 'crypto';
import { secp256k1 } from '@noble/curves/secp256k1';

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, content: Buffer) =>
  Buffer.concat([Buffer.from([tag]), length(content.length), content]);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));

const ECDSA_SHA256 = Buffer.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]);
const EC_PUBLIC_KEY = Buffer.from([0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
const SECP256K1 = Buffer.from([0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a]);
const COMMON_NAME = Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]);

function name(cn: string): Buffer {
  return seq(set(seq(COMMON_NAME, tlv(0x0c, Buffer.from(cn, 'utf8')))));
}

export interface TestCredential {
  certificate: string;
  privateKey: string;
  publicKeyDer: Buffer;
}

export function makeTestCredential(commonName = 'FactorPOS test EGS'): TestCredential {
  const secret = secp256k1.utils.randomPrivateKey();
  const point = Buffer.from(secp256k1.getPublicKey(secret, false));
  const spki = seq(
    seq(EC_PUBLIC_KEY, SECP256K1),
    tlv(0x03, Buffer.concat([Buffer.from([0]), point])),
  );
  const serial = Buffer.concat([Buffer.from([0x01]), crypto.randomBytes(8)]);
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([0x02]))),
    tlv(0x02, serial),
    seq(ECDSA_SHA256),
    name('FactorPOS test CA'),
    seq(tlv(0x17, Buffer.from('260101000000Z')), tlv(0x17, Buffer.from('360101000000Z'))),
    name(commonName),
    spki,
  );
  const digest = crypto.createHash('sha256').update(tbs).digest();
  const signature = Buffer.from(secp256k1.sign(digest, secret).toDERRawBytes());
  const der = seq(tbs, seq(ECDSA_SHA256), tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const sec1 = seq(
    tlv(0x02, Buffer.from([0x01])),
    tlv(0x04, Buffer.from(secret)),
    tlv(0xa0, SECP256K1),
    tlv(0xa1, tlv(0x03, Buffer.concat([Buffer.from([0]), point]))),
  );
  const pem = sec1
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n');
  return {
    certificate: der.toString('base64'),
    privateKey: `-----BEGIN EC PRIVATE KEY-----\n${pem}\n-----END EC PRIVATE KEY-----\n`,
    publicKeyDer: spki,
  };
}
