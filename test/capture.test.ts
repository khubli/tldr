import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAccessKeyCache } from "../src/access";
import { cleanUrl, parseCapture } from "../src/capture";
import worker from "../src/index";
import { authed, form, stubCerts } from "./helpers";

// Fictional fixtures: Contoso, Fabrikam and Woodgrove Bank.
const X_SHARE = {
  title: "",
  text: "Post by @contoso_eng on X: we cut cold starts by 40% https://x.com/contoso_eng/status/1850000000000000001?s=46&t=AbCdEf",
};
const ARTICLE_SHARE = {
  title: "How Fabrikam ships on Fridays",
  text: "",
  url: "https://blog.fabrikam.example/fridays?utm_source=share&utm_medium=android&ref=home#comments",
};

describe("parseCapture", () => {
  it("finds the link inside shared text, the way the X app shares", () => {
    expect(parseCapture(X_SHARE)).toEqual({
      url: "https://x.com/contoso_eng/status/1850000000000000001",
      title: null,
      text: "Post by @contoso_eng on X: we cut cold starts by 40%",
    });
  });

  it("uses the url field when the app fills it, and strips tracking", () => {
    expect(parseCapture(ARTICLE_SHARE)).toEqual({
      url: "https://blog.fabrikam.example/fridays?ref=home",
      title: "How Fabrikam ships on Fridays",
      text: null,
    });
  });

  it("keeps plain text when there is no link", () => {
    expect(parseCapture({ text: "  Ask Woodgrove Bank about the API sandbox  " })).toEqual({
      url: null,
      title: null,
      text: "Ask Woodgrove Bank about the API sandbox",
    });
  });

  it("drops text that was only the link", () => {
    expect(parseCapture({ text: "https://contoso.example/post." }).text).toBeNull();
  });

  it("rejects links that aren't web pages", () => {
    expect(cleanUrl("javascript:alert(1)")).toBeNull();
    expect(cleanUrl("file:///etc/passwd")).toBeNull();
    expect(cleanUrl("not a url")).toBeNull();
  });

  it("treats twitter.com and x.com links as the same", () => {
    expect(cleanUrl("http://mobile.twitter.com/contoso/status/1?s=20")).toBe("https://x.com/contoso/status/1");
  });
});

describe("capture flow", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM saves").run();
    resetAccessKeyCache();
    await stubCerts();
  });
  afterEach(() => vi.restoreAllMocks());

  const send = async (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => {
    const f = form(fields);
    return worker.fetch(await authed(path, { method: "POST", body: f.body, headers: { ...f.headers, ...headers } }), env);
  };
  const home = async () => (await worker.fetch(await authed("/"), env)).text();
  const wire = async () => (await worker.fetch(await authed("/file"), env)).text();

  it("a link shared from the phone shows up in the list", async () => {
    const res = await send("/share", X_SHARE, { "Sec-Fetch-Site": "none" });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("https://tldr.example/?flash=filed");

    // The Desk confirms it and counts it as waiting for the editor...
    const desk = await (await worker.fetch(await authed("/?flash=filed"), env)).text();
    expect(desk).toContain("Filed");
    expect(desk).toContain("1 waiting for the editor");
    // ...and the wire lists it until the morning run.
    const html = await wire();
    expect(html).toContain('href="https://x.com/contoso_eng/status/1850000000000000001"');
    expect(html).toContain("we cut cold starts by 40%");
    expect(html).toContain("via x.com");
    expect(html).toContain("Saved just now · Shared");
    expect(html).toContain("The wire · 1 waiting for the editor");
  });

  it("the paste box files copy too", async () => {
    const res = await send("/save", { text: "https://blog.fabrikam.example/fridays" }, { "Sec-Fetch-Site": "same-origin", Origin: "https://tldr.example" });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("https://tldr.example/file?flash=filed");
    expect(await wire()).toContain("Pasted");
  });

  it("saving the same link twice keeps one copy", async () => {
    await send("/share", ARTICLE_SHARE);
    const again = await send("/save", { text: "look https://blog.fabrikam.example/fridays?ref=home&utm_campaign=x" });
    expect(again.headers.get("Location")).toBe("https://tldr.example/file?flash=duplicate");
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM saves").first<{ n: number }>())!;
    expect(n).toBe(1);
  });

  it("an empty share files nothing", async () => {
    const res = await send("/share", { title: "", text: "  ", url: "" });
    expect(res.headers.get("Location")).toBe("https://tldr.example/?flash=empty");
    expect(await wire()).toContain("No copy waiting");
  });

  it("refuses posts from other sites", async () => {
    expect((await send("/save", { text: "spam" }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await send("/share", { text: "spam" }, { Origin: "https://fabrikam.example" })).status).toBe(403);
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM saves").first<{ n: number }>())!;
    expect(n).toBe(0);
  });

  it("escapes whatever was shared", async () => {
    await send("/share", { title: '<script>alert("x")</script>', text: "<img src=x onerror=alert(1)>" });
    const html = await wire();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("serves the manifest with a share target to the reader", async () => {
    const res = await worker.fetch(await authed("/manifest.webmanifest"), env);
    expect(res.status).toBe(200);
    const manifest = await res.json<{ share_target: { action: string; method: string } }>();
    expect(manifest.share_target).toMatchObject({ action: "/share", method: "POST" });
  });

  it("sends no-store and a strict content policy on every response", async () => {
    const res = await worker.fetch(await authed("/"), env);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });
});
