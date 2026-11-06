// Cloudflare Access check. Fails closed: if anything is missing, wrong or
// unexpected, the caller gets `null` and the request is refused.
//
// Access puts a signed JWT in the `Cf-Access-Jwt-Assertion` header on every
// request it lets through. We verify it ourselves against the team's public
// keys, so a request that somehow skips Access (or forges the header) is
// still refused.

export interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string; // e.g. yourteam.cloudflareaccess.com
  ACCESS_AUD?: string; // the Access application's Audience tag
  ALLOWED_EMAIL?: string; // the one reader allowed in
  ALLOW_LOCAL_DEV?: string; // "true" only in .dev.vars, for wrangler dev on localhost
}

export interface Reader {
  email: string;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

const CLOCK_SKEW_SECONDS = 60;
const KEY_CACHE_MS = 10 * 60 * 1000;

let keyCache: { team: string; keys: Jwk[]; fetchedAt: number } | null = null;

/** Clears the cached signing keys. Used by tests. */
export function resetAccessKeyCache(): void {
  keyCache = null;
}

export async function checkAccess(request: Request, env: AccessEnv): Promise<Reader | null> {
  try {
    if (isLocalDev(request, env)) {
      return { email: "local-dev@localhost" };
    }

    const team = env.ACCESS_TEAM_DOMAIN?.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const aud = env.ACCESS_AUD?.trim();
    const allowed = env.ALLOWED_EMAIL?.trim().toLowerCase();
    if (!team || !aud || !allowed) {
      console.error("Access check: ACCESS_TEAM_DOMAIN, ACCESS_AUD and ALLOWED_EMAIL must all be set.");
      return null;
    }

    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) return null;

    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;

    const header = JSON.parse(decodeText(headerB64));
    if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

    const jwk = await findKey(team, header.kid);
    if (!jwk) return null;

    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlDecode(sigB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    );
    if (!valid) return null;

    const claims = JSON.parse(decodeText(payloadB64));
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== `https://${team}`) return null;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(aud)) return null;
    if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < now) return null;
    if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > now) return null;
    if (typeof claims.email !== "string" || claims.email.toLowerCase() !== allowed) return null;

    return { email: claims.email };
  } catch (err) {
    console.error("Access check failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

// Local development only: needs ALLOW_LOCAL_DEV=true (set in the gitignored
// .dev.vars) AND a request to localhost. Production traffic arrives on the
// custom domain, so this can never open the deployed site.
function isLocalDev(request: Request, env: AccessEnv): boolean {
  if (env.ALLOW_LOCAL_DEV !== "true") return false;
  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1";
}

async function findKey(team: string, kid: string): Promise<Jwk | undefined> {
  const fresh = keyCache && keyCache.team === team && Date.now() - keyCache.fetchedAt < KEY_CACHE_MS;
  if (fresh) {
    const hit = keyCache!.keys.find((k) => k.kid === kid);
    if (hit) return hit;
  }
  // Unknown key or stale cache: Access may have rotated keys, so refetch once.
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) return undefined;
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  keyCache = { team, keys, fetchedAt: Date.now() };
  return keys.find((k) => k.kid === kid);
}

function base64UrlDecode(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeText(input: string): string {
  return new TextDecoder().decode(base64UrlDecode(input));
}
