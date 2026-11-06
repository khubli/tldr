// Mints Cloudflare Access style JWTs with a throwaway key, and serves the
// matching public key from a stubbed certs endpoint. All names are fictional.
import { vi } from "vitest";

export const TEAM = "contoso.cloudflareaccess.com";
export const AUD = "test-audience-tag";
export const READER = "reader@contoso.example";
export const KID = "test-key-1";

let keyPair: CryptoKeyPair | null = null;

async function keys(): Promise<CryptoKeyPair> {
  keyPair ??= (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return keyPair;
}

/** Answers a stubbed outside request, or returns undefined to fall through. */
export type FetchRoute = (url: URL, init?: RequestInit) => Response | undefined | Promise<Response | undefined>;

/**
 * Stubs outside calls: the Access certs endpoint, plus any extra routes a test
 * passes (X API, oEmbed). X's endpoints answer 404 unless a route handles
 * them, so no test ever reaches the real X.
 */
export async function stubCerts(route?: FetchRoute): Promise<void> {
  const jwk = await crypto.subtle.exportKey("jwk", (await keys()).publicKey);
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (href === `https://${TEAM}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" }] });
    }
    const url = new URL(href);
    const routed = route ? await route(url, init) : undefined;
    if (routed) return routed;
    if (/(^|\.)(x|twitter)\.com$/.test(url.hostname)) return new Response(null, { status: 404 });
    return realFetch(input, init);
  });
}

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function mintToken(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  signWith?: CryptoKey,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT", ...header }));
  const p = b64url(
    JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], email: READER, iat: now, nbf: now, exp: now + 600, ...claims }),
  );
  const key = signWith ?? (await keys()).privateKey;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}

export async function otherPrivateKey(): Promise<CryptoKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return pair.privateKey;
}

export const ORIGIN = "https://tldr.example";

export async function authed(path: string, init: RequestInit = {}): Promise<Request> {
  const headers = new Headers(init.headers);
  headers.set("Cf-Access-Jwt-Assertion", await mintToken());
  return new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" });
}

export function form(fields: Record<string, string>): { body: string; headers: Record<string, string> } {
  return {
    body: new URLSearchParams(fields).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  };
}
