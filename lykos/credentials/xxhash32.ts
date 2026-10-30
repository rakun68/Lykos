// xxHash32.
//
// A session's starting credential is `xxHash32(sessionId) % n` over the id's
// UTF-8 bytes with seed 0. Node has no xxHash, so this is the reference
// algorithm (Yann Collet, xxHash specification).

const PRIME1 = 0x9e3779b1;
const PRIME2 = 0x85ebca77;
const PRIME3 = 0xc2b2ae3d;
const PRIME4 = 0x27d4eb2f;
const PRIME5 = 0x165667b1;

function rotl(x: number, r: number): number {
  return (x << r) | (x >>> (32 - r));
}

function round(acc: number, lane: number): number {
  return Math.imul(rotl((acc + Math.imul(lane, PRIME2)) | 0, 13), PRIME1);
}

/** xxHash32 of `input`'s UTF-8 bytes, as an unsigned 32-bit integer. */
export function xxHash32(input: string, seed = 0): number {
  const buf = Buffer.from(input, "utf8");
  const len = buf.length;
  let i = 0;
  let h: number;

  if (len >= 16) {
    let v1 = (seed + PRIME1 + PRIME2) | 0;
    let v2 = (seed + PRIME2) | 0;
    let v3 = seed | 0;
    let v4 = (seed - PRIME1) | 0;
    const limit = len - 16;
    while (i <= limit) {
      v1 = round(v1, buf.readUInt32LE(i));
      v2 = round(v2, buf.readUInt32LE(i + 4));
      v3 = round(v3, buf.readUInt32LE(i + 8));
      v4 = round(v4, buf.readUInt32LE(i + 12));
      i += 16;
    }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) | 0;
  } else {
    h = (seed + PRIME5) | 0;
  }

  h = (h + len) | 0;

  while (i + 4 <= len) {
    h = (h + Math.imul(buf.readUInt32LE(i), PRIME3)) | 0;
    h = Math.imul(rotl(h, 17), PRIME4);
    i += 4;
  }
  while (i < len) {
    h = (h + Math.imul(buf[i]!, PRIME5)) | 0;
    h = Math.imul(rotl(h, 11), PRIME1);
    i += 1;
  }

  h ^= h >>> 15;
  h = Math.imul(h, PRIME2);
  h ^= h >>> 13;
  h = Math.imul(h, PRIME3);
  h ^= h >>> 16;
  return h >>> 0;
}
