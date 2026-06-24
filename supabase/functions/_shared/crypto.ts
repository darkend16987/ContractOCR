// Ed25519 signing/verifying for the license server (Deno Web Crypto).
//
// Same scheme as the desktop app + CLI: the message that gets signed is the
// ASCII of the base64url-encoded JSON body. The server holds the PRIVATE key
// (env LICENSE_PRIVATE_KEY, PKCS8 PEM) to mint license keys + activation tokens;
// the desktop app ships only the matching PUBLIC key and verifies offline.
//
//   License key:      NABU1.<payload_b64url>.<sig_b64url>   (given to the user)
//   Activation token: NABT1.<payload_b64url>.<sig_b64url>   (short-lived, per machine)

function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function b64urlEncode(bytes: Uint8Array): string {
  const s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s: string): Uint8Array {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
}

const utf8 = (s: string) => new TextEncoder().encode(s);

let privKey: CryptoKey | null = null;
async function getPriv(): Promise<CryptoKey> {
  if (privKey) return privKey;
  const pem = Deno.env.get("LICENSE_PRIVATE_KEY");
  if (!pem) throw new Error("LICENSE_PRIVATE_KEY not set");
  privKey = await crypto.subtle.importKey("pkcs8", pemToDer(pem), { name: "Ed25519" }, false, ["sign"]);
  return privKey;
}

// Public verify key — not a secret (it's the same one shipped in the desktop
// app), so it's inlined here. Only LICENSE_PRIVATE_KEY needs to be a secret.
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAlgq1j3lABmH3qzob4J14ZqJYiceLInaoXjvNvrmBD5A=
-----END PUBLIC KEY-----`;

let pubKey: CryptoKey | null = null;
async function getPub(): Promise<CryptoKey> {
  if (pubKey) return pubKey;
  pubKey = await crypto.subtle.importKey("spki", pemToDer(PUBLIC_KEY_PEM), { name: "Ed25519" }, false, ["verify"]);
  return pubKey;
}

async function signBody(prefix: string, payload: unknown): Promise<string> {
  const body = b64urlEncode(utf8(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, await getPriv(), utf8(body)));
  return `${prefix}.${body}.${b64urlEncode(sig)}`;
}

async function verifyBody(prefix: string, token: string): Promise<Record<string, unknown> | null> {
  const parts = (token || "").trim().split(".");
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const [, body, sig] = parts;
  let ok = false;
  try {
    ok = await crypto.subtle.verify({ name: "Ed25519" }, await getPub(), b64urlToBytes(sig), utf8(body));
  } catch {
    ok = false;
  }
  if (!ok) return null;
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
  } catch {
    return null;
  }
}

/** Mint a portable license key (NABU1). `payload` is recorded in the DB too. */
export const signLicenseKey = (payload: unknown) => signBody("NABU1", payload);

/** Verify a license key signature and return its payload (or null). */
export const verifyLicenseKey = (key: string) => verifyBody("NABU1", key);

/** Mint a short-lived activation token (NABT1) the app verifies offline. */
export const signToken = (payload: unknown) => signBody("NABT1", payload);

/**
 * Verify an activation token signature and return its payload — even if it is
 * past `exp`, so `/refresh` can re-issue within a grace window. Callers must
 * still check `exp`/`lic_exp`/status themselves.
 */
export const verifyToken = (token: string) => verifyBody("NABT1", token);
