// Remote MCP endpoint: how the daily Claude run reaches tldr.
//
// Claude's servers call this, and they can't pass Cloudflare Access, so /mcp
// has an Access bypass and its own check instead: a long random token, either
// in the path (`/mcp/<token>`, for Claude's custom connector, which takes a
// URL) or as `Authorization: Bearer <token>` on `/mcp` (for Claude Code and
// other clients that can send headers). No token, wrong token, or no
// MCP_TOKEN secret: an empty 404. It fails closed like the rest of the site.
//
// Transport: MCP "Streamable HTTP", stateless. Each POST carries one JSON-RPC
// message and gets one JSON answer. No server-sent events, no sessions.

import {
  ACTION_TYPES,
  SPIKE_REASONS,
  ToolInputError,
  getFeedback,
  getProfile,
  listUntriaged,
  publishMorningRun,
  saveTriage,
  searchSaves,
} from "./brain";
import { sendMorningMail, type MailEnv } from "./loop";

export interface McpEnv {
  MCP_TOKEN?: string; // at least 32 characters; `openssl rand -hex 32`
}

type ToolEnv = Omit<MailEnv, "DB"> & { DB: D1Database; EDITION_TZ?: string };

const MIN_TOKEN_LENGTH = 32;
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "tldr", version: "0.3.0" };

const INSTRUCTIONS =
  "tldr is one reader's saved posts. You are its editor. Read the profile first; it is the lens for every " +
  "verdict. Then triage untriaged saves in batches (keep or spike, with a short TLDR and at most one action " +
  "for keeps), and finish with one publish_morning_run. The full brief is in docs/brain-prompt.md.";

export function isMcpPath(pathname: string): boolean {
  return pathname === "/mcp" || pathname.startsWith("/mcp/");
}

export async function handleMcp(
  request: Request,
  env: McpEnv & ToolEnv,
): Promise<Response> {
  if (!(await isAuthorized(request, env))) return new Response(null, { status: 404 });

  // A browser on another site must never drive the endpoint (DNS rebinding,
  // stray tabs). Claude's servers send no Origin.
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return new Response(null, { status: 403 });

  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(rpcError(null, -32700, "Parse error"));
  }

  const messages = Array.isArray(body) ? body : [body];
  const answers: unknown[] = [];
  for (const message of messages) {
    const answer = await dispatch(message, env);
    if (answer) answers.push(answer);
  }
  // Only notifications: nothing to say.
  if (answers.length === 0) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? answers : answers[0]);
}

async function isAuthorized(request: Request, env: McpEnv): Promise<boolean> {
  const secret = env.MCP_TOKEN?.trim();
  if (!secret || secret.length < MIN_TOKEN_LENGTH) {
    if (secret !== undefined) console.error("MCP_TOKEN is shorter than 32 characters; /mcp stays closed.");
    return false;
  }
  const { pathname } = new URL(request.url);
  let given: string | null = null;
  if (pathname === "/mcp") {
    const auth = request.headers.get("Authorization") ?? "";
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    given = m ? m[1] : null;
  } else {
    const rest = pathname.slice("/mcp/".length);
    given = rest && !rest.includes("/") ? rest : null;
  }
  if (!given) return false;
  return sameSecret(given, secret);
}

// Constant-time compare: hash both sides so lengths match, then compare.
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

type RpcId = string | number | null;

async function dispatch(message: unknown, env: ToolEnv): Promise<unknown | null> {
  if (typeof message !== "object" || message === null || (message as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
    return rpcError(null, -32600, "Invalid Request");
  }
  const { id, method, params } = message as { id?: RpcId; method?: unknown; params?: Record<string, unknown> };
  const isNotification = id === undefined;
  if (typeof method !== "string") return isNotification ? null : rpcError(id, -32600, "Invalid Request");
  if (isNotification) return null; // notifications/initialized, cancelled, ...

  switch (method) {
    case "initialize": {
      const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const name = typeof params?.name === "string" ? params.name : "";
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      const tool = HANDLERS[name];
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      try {
        const result = await tool(args, env);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        if (err instanceof ToolInputError) {
          return rpcResult(id, { content: [{ type: "text", text: err.message }], isError: true });
        }
        console.error(`MCP tool ${name} failed:`, err instanceof Error ? err.message : err);
        return rpcResult(id, { content: [{ type: "text", text: "tldr hit an internal error. Try again." }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

type Handler = (args: Record<string, unknown>, env: ToolEnv) => Promise<unknown>;

const HANDLERS: Record<string, Handler> = {
  get_profile: (_a, env) => getProfile(env.DB),
  list_untriaged: (a, env) => listUntriaged(env.DB, a.limit),
  save_triage: (a, env) => saveTriage(env.DB, a.items, new Date()),
  publish_morning_run: async (a, env) => {
    const now = new Date();
    const run = await publishMorningRun(env.DB, a, now, env.EDITION_TZ || "UTC");
    // The morning email goes out once the run is in. A failed email never
    // fails the run; it is logged and shows on the Desk.
    const email = await sendMorningMail(env, now).catch((err) => `failed: ${err instanceof Error ? err.message : err}`);
    return { ...run, email };
  },
  get_feedback: (a, env) => getFeedback(env.DB, a.days, new Date()),
  search_saves: (a, env) => searchSaves(env.DB, a.query, a.limit),
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOLS = [
  {
    name: "get_profile",
    title: "Read the reader's profile",
    description:
      "The reader's profile in Markdown: who they are, what they're building, what they care about. " +
      "It is the lens for every keep/spike call. Read it once at the start of a run.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
  },
  {
    name: "list_untriaged",
    title: "List saves waiting for triage",
    description:
      "Saves not yet triaged, oldest first, with their text (first 4,000 characters). " +
      "`remaining` says how many more are waiting after this batch.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 50, default: 20 } },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "save_triage",
    title: "Save verdicts",
    description:
      "Write the editor's verdict for up to 50 saves. Keep: headline (≤10 words), tldr (≤3 lines), why_you " +
      "(1 line tied to the profile), rank 0–100, optional action. Spike: headline and spike_reason. A keep " +
      "with an action puts it on the Desk. Items with problems come back in `errors`; the rest are saved. " +
      "Re-saving a save replaces its verdict.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              id: { type: "integer", description: "The save's id from list_untriaged." },
              verdict: { type: "string", enum: ["keep", "spike"] },
              spike_reason: { type: "string", enum: [...SPIKE_REASONS], description: "Required when verdict is spike." },
              headline: { type: "string", maxLength: 120 },
              tldr: { type: "string", maxLength: 500, description: "Required when verdict is keep." },
              why_you: { type: "string", maxLength: 200 },
              action: {
                type: "object",
                description: "At most one concrete next step, for keeps only. Leave out when there is none.",
                properties: {
                  type: { type: "string", enum: [...ACTION_TYPES] },
                  project: { type: "string", maxLength: 40, description: "Which of the reader's projects it serves, if any." },
                  text: { type: "string", maxLength: 200 },
                },
                required: ["type", "text"],
              },
              rank: { type: "integer", minimum: 0, maximum: 100, description: "How much it matters this week. Keeps default to 50, spikes to 0." },
              tags: { type: "array", items: { type: "string" }, maxItems: 8 },
            },
            required: ["id", "verdict", "headline"],
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
    annotations: WRITES,
  },
  {
    name: "publish_morning_run",
    title: "Publish the morning run",
    description:
      "Close the run: a one-paragraph lede for the morning email, plus up to 10 kept saves to highlight. " +
      "The run's numbers (triaged, kept, spiked by reason, open actions) are counted for you. Publishing sends " +
      "the reader the morning email (once a day; `email` in the result says whether it went). Publishing " +
      "again the same day replaces that day's run but doesn't send a second email.",
    inputSchema: {
      type: "object",
      properties: {
        lede: { type: "string", maxLength: 1500 },
        highlight_ids: { type: "array", items: { type: "integer" }, maxItems: 10 },
      },
      required: ["lede"],
      additionalProperties: false,
    },
    annotations: WRITES,
  },
  {
    name: "get_feedback",
    title: "What the reader did with past actions",
    description:
      "Actions the reader marked done, snoozed or dropped in the last N days, with counts by action type. " +
      "Use it to tune what gets kept and what gets an action.",
    inputSchema: {
      type: "object",
      properties: { days: { type: "integer", minimum: 1, maximum: 90, default: 14 } },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "search_saves",
    title: "Search past saves",
    description:
      "Find earlier saves by words in their text, title, author, link, headline, TLDR or tags. " +
      "Use it to spot reposts and to link a new save to older ones.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
];

function rpcResult(id: RpcId, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: RpcId | undefined, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
}
