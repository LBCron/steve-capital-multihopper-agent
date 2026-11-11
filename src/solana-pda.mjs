/**
 * Zero-dependency Solana Base58, Ed25519 Curve Residency (`CompressedEdwardsY::decompress`),
 * Deterministic `findProgramAddressSync` PDA Engine, and Live Solana Mainnet RPC Verifier.
 *
 * Matches `@solana/web3.js` `PublicKey.findProgramAddressSync` bit-for-bit.
 */

import crypto from "node:crypto";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_MAP = new Map([...BASE58_ALPHABET].map((ch, idx) => [ch, BigInt(idx)]));

// Ed25519 field prime p = 2^255 - 19 and twisted Edwards constant d = -121665 / 121666 mod p
const P = (1n << 255n) - 19n;
const P_MINUS_5_DIV_8 = (P - 5n) / 8n;

function mod(a, m = P) {
  const r = a % m;
  return r < 0n ? r + m : r;
}

function modPow(base, exp, m = P) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

const D = mod(-121665n * modPow(121666n, P - 2n));
const SQRT_M1 = modPow(2n, (P - 1n) / 4n);

/**
 * Decodes a Base58 Solana PublicKey string into a 32-byte Buffer.
 */
export function decodeBase58PublicKey(address) {
  if (typeof address !== "string" || address.length === 0) {
    throw new Error("Invalid Solana public key: empty string");
  }
  let num = 0n;
  for (const ch of address) {
    const val = BASE58_MAP.get(ch);
    if (val === undefined) {
      throw new Error(`Invalid Base58 character '${ch}' in ${address}`);
    }
    num = num * 58n + val;
  }
  let leadingZeros = 0;
  for (const ch of address) {
    if (ch === "1") leadingZeros++;
    else break;
  }
  const hex = num === 0n ? "" : num.toString(16).padStart(2, "0");
  const paddedHex = hex.length % 2 === 1 ? `0${hex}` : hex;
  const body = paddedHex ? Buffer.from(paddedHex, "hex") : Buffer.alloc(0);
  const out = Buffer.concat([Buffer.alloc(leadingZeros), body]);
  if (out.length !== 32) {
    throw new Error(`Decoded Solana public key must be 32 bytes (got ${out.length} for ${address})`);
  }
  return out;
}

/**
 * Encodes a 32-byte Buffer into a Base58 Solana PublicKey string.
 */
export function encodeBase58(bytes) {
  const buf = Buffer.from(bytes);
  let leadingZeros = 0;
  for (const b of buf) {
    if (b === 0) leadingZeros++;
    else break;
  }
  let num = 0n;
  for (const b of buf) {
    num = (num << 8n) + BigInt(b);
  }
  const chars = [];
  while (num > 0n) {
    const rem = Number(num % 58n);
    chars.push(BASE58_ALPHABET[rem]);
    num /= 58n;
  }
  chars.reverse();
  return "1".repeat(leadingZeros) + chars.join("");
}

/**
 * Exact port of `curve25519-dalek` / `@solana/web3.js` `PublicKey.isOnCurve(bytes)`.
 * Returns true iff the 32-byte compressed Edwards Y point decompresses onto Ed25519.
 *Note: non-canonical y >= p is actually accepted modulo p in curve25519-dalek v3 or rejected in v4;
 * Solana runtime uses `curve25519_dalek::edwards::CompressedEdwardsY::decompress` which reduces y mod p:
 *   u = y^2 - 1, v = d*y^2 + 1
 *   x = u * v^3 * (u * v^7)^((p - 5)/8) mod p
 *   valid iff v * x^2 == u (then x) or v * x^2 == -u (then x * sqrt(-1)),
 *   and refuses sign=1 when x == 0.
 */
export function isOnEd25519Curve(pubkeyBytes) {
  if (pubkeyBytes.length !== 32) return false;
  const copy = Uint8Array.from(pubkeyBytes);
  const signBit = (copy[31] >> 7) & 1;
  copy[31] &= 0x7f;

  // Little-endian 255-bit integer y
  let y = 0n;
  for (let i = 31; i >= 0; i--) {
    y = (y << 8n) | BigInt(copy[i]);
  }
  // curve25519-dalek decompress reduces y mod p via FieldElement::from_bytes
  y = mod(y);

  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);

  const v3 = mod(mod(v * v) * v);
  const v7 = mod(mod(v3 * v3) * v);
  const uv7 = mod(u * v7);
  let x = mod(mod(u * v3) * modPow(uv7, P_MINUS_5_DIV_8));

  const vx2 = mod(v * mod(x * x));
  if (vx2 === u) {
    // valid root as-is
  } else if (vx2 === mod(-u)) {
    x = mod(x * SQRT_M1);
  } else {
    return false;
  }

  if (x === 0n && signBit === 1) {
    return false;
  }
  return true;
}

const PDA_MARKER = Buffer.from("ProgramDerivedAddress", "utf8");
const MAX_SEED_LENGTH = 32;
const MAX_SEEDS = 16;

/**
 * Computes `createProgramAddressSync(seeds, programIdBytes)` — throws if the SHA-256 digest lies on Ed25519.
 */
export function createProgramAddressSync(seeds, programId) {
  if (seeds.length > MAX_SEEDS) {
    throw new Error(`Max number of seeds (${MAX_SEEDS}) exceeded`);
  }
  const programBuf = typeof programId === "string" ? decodeBase58PublicKey(programId) : Buffer.from(programId);
  if (programBuf.length !== 32) {
    throw new Error("programId must be 32 bytes");
  }
  const hasher = crypto.createHash("sha256");
  for (const s of seeds) {
    const buf = typeof s === "string" ? Buffer.from(s, "utf8") : Buffer.from(s);
    if (buf.length > MAX_SEED_LENGTH) {
      throw new Error(`Max seed length (${MAX_SEED_LENGTH}) exceeded: got ${buf.length}`);
    }
    hasher.update(buf);
  }
  hasher.update(programBuf);
  hasher.update(PDA_MARKER);
  const digest = hasher.digest();
  if (isOnEd25519Curve(digest)) {
    throw new Error("Invalid seeds, point must fall off the Ed25519 curve");
  }
  return {
    address: encodeBase58(digest),
    bytes: digest,
  };
}

/**
 * Exact equivalent of `@solana/web3.js` `PublicKey.findProgramAddressSync(seeds, programId)`.
 */
export function findProgramAddressSync(seeds, programId) {
  for (let nonce = 255; nonce >= 0; nonce--) {
    try {
      const derived = createProgramAddressSync([...seeds, Buffer.from([nonce])], programId);
      return [derived.address, nonce, derived.bytes];
    } catch (err) {
      if (!String(err.message).includes("off the Ed25519 curve")) {
        throw err;
      }
    }
  }
  throw new Error("Unable to find a viable program address nonce");
}

/**
 * Queries a Solana JSON-RPC endpoint (`mainnet-beta` by default) to verify executable status of target programs.
 */
export async function verifyMainnetPrograms(
  programAddresses,
  rpcUrl = "https://api.mainnet-beta.solana.com",
  fetchImpl = globalThis.fetch
) {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getMultipleAccounts",
      params: [programAddresses, { encoding: "base64" }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Solana RPC getMultipleAccounts failed with HTTP ${res.status}`);
  }
  const body = await res.json();
  const contextSlot = body?.result?.context?.slot ?? null;
  const values = body?.result?.value ?? [];
  return {
    rpcUrl,
    contextSlot,
    programs: programAddresses.map((address, idx) => {
      const info = values[idx];
      return {
        address,
        exists: Boolean(info),
        executable: Boolean(info?.executable),
        owner: info?.owner ?? null,
        lamports: info?.lamports ?? 0,
      };
    }),
  };
}
