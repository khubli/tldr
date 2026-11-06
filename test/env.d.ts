// Types for the `env` the tests see. Mirrors `Env` in src/index.ts.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    EDITION_TZ?: string;
    ACCESS_TEAM_DOMAIN?: string;
    ACCESS_AUD?: string;
    ALLOWED_EMAIL?: string;
    ALLOW_LOCAL_DEV?: string;
    X_CLIENT_ID?: string;
    X_CLIENT_SECRET?: string;
    MCP_TOKEN?: string;
    MAILER?: SendEmail;
    MAIL_FROM?: string;
    MAIL_TO?: string;
    SITE_URL?: string;
    GITHUB_USER?: string;
    GITHUB_TOKEN?: string;
    YOUTUBE_API_KEY?: string;
    YOUTUBE_PLAYLIST_ID?: string;
    ANTHROPIC_API_KEY?: string;
    OPENROUTER_API_KEY?: string;
    LLM_API_KEY?: string;
    LLM_BASE_URL?: string;
    AI_MODEL?: string;
    EDITOR_HOUR?: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
