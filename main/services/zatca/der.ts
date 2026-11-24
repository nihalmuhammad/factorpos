/**
 * FactorPOS: the few DER (ASN.1) encoders the ZATCA certificate request needs. Kept
 * small and explicit instead of adding an ASN.1 library.
 */

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export const tlv = (tag: number, content: Buffer) =>
  Buffer.concat([Buffer.from([tag]), length(content.length), content]);

export const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
export const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
export const integer = (bytes: number[] | Buffer) => tlv(0x02, Buffer.from(bytes));
export const octets = (content: Buffer) => tlv(0x04, content);
export const utf8 = (text: string) => tlv(0x0c, Buffer.from(text, 'utf8'));
export const printable = (text: string) => tlv(0x13, Buffer.from(text, 'ascii'));
/** BIT STRING with no unused bits. */
export const bits = (content: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), content]));

export function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const body: number[] = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    for (let v = Math.floor(part / 128); v > 0; v = Math.floor(v / 128)) {
      chunk.unshift((v & 0x7f) | 0x80);
    }
    body.push(...chunk);
  }
  return tlv(0x06, Buffer.from(body));
}

export function pem(label: string, der: Buffer): string {
  const body = der
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}
