import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAccessKeyCache } from "../src/access";
import worker from "../src/index";
import { AUD, ORIGIN, mintToken, otherPrivateKey, stubCerts } from "./helpers";

async function get(path: string, token?: string, envOverride: Partial<Cloudflare.Env> = {}) {
  const headers = token ? { "Cf-Access-Jwt-Assertion": token } : undefined;
  return worker.fetch(new Request(`${ORIGIN}${path}`, { headers }), { ...env, ...envOverride });
}

async function expectRefused(res: Response) {
  expect(res.status).toBe(403);
  expect(await res.text()).toBe("");
}

describe("Access check (fails closed)", () => {
  beforeEach(async () => {
    resetAccessKeyCache();
    await stubCerts();
  });
  afterEach(() => vi.restoreAllMocks());

  it("lets the reader in with a valid Access token", async () => {
    const res = await get("/", await mintToken());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("The tl;dr");
  });

  it("refuses a request with no token", async () => {
    await expectRefused(await get("/"));
  });

  it("refuses the manifest, icons and scripts without a token too", async () => {
    for (const path of ["/manifest.webmanifest", "/icon-192.png", "/sw.js", "/style.css", "/nope"]) {
      await expectRefused(await get(path));
    }
  });

  it("refuses a token signed by another key", async () => {
    await expectRefused(await get("/", await mintToken({}, {}, await otherPrivateKey())));
  });

  it("refuses a token for another Access application", async () => {
    await expectRefused(await get("/", await mintToken({ aud: ["fabrikam-app"] })));
  });

  it("refuses a token from another team", async () => {
    await expectRefused(await get("/", await mintToken({ iss: "https://fabrikam.cloudflareaccess.com" })));
  });

  it("refuses an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    await expectRefused(await get("/", await mintToken({ exp: past, iat: past - 600, nbf: past - 600 })));
  });

  it("refuses a token for anyone else, even one Access let in", async () => {
    await expectRefused(await get("/", await mintToken({ email: "someone@woodgrovebank.example" })));
  });

  it("refuses a token with no email (e.g. a service token)", async () => {
    await expectRefused(await get("/", await mintToken({ email: undefined })));
  });

  it("refuses unsigned or oddly signed tokens", async () => {
    const good = await mintToken();
    const [, payload] = good.split(".");
    const none = `${btoa(JSON.stringify({ alg: "none", kid: "test-key-1" })).replace(/=+$/, "")}.${payload}.`;
    await expectRefused(await get("/", none));
    await expectRefused(await get("/", await mintToken({}, { alg: "HS256" })));
    await expectRefused(await get("/", await mintToken({}, { kid: "unknown-key" })));
    await expectRefused(await get("/", "not-a-jwt"));
  });

  it("refuses everyone when it isn't configured", async () => {
    const token = await mintToken();
    await expectRefused(await get("/", token, { ACCESS_AUD: undefined }));
    await expectRefused(await get("/", token, { ACCESS_TEAM_DOMAIN: "" }));
    await expectRefused(await get("/", token, { ALLOWED_EMAIL: undefined }));
  });

  it("refuses everyone when the signing keys can't be fetched", async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 503 }));
    await expectRefused(await get("/", await mintToken()));
  });

  it("only skips the check for localhost when local dev is switched on", async () => {
    const local = (url: string, flag?: string) =>
      worker.fetch(new Request(url), { ...env, ALLOW_LOCAL_DEV: flag });
    expect((await local("http://localhost:8787/", "true")).status).toBe(200);
    await expectRefused(await local("http://localhost:8787/"));
    await expectRefused(await local(`${ORIGIN}/`, "true"));
  });

  it("uses the configured audience", () => {
    expect(env.ACCESS_AUD).toBe(AUD);
  });
});
