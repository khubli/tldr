import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // Fictional test settings. Real values are wrangler secrets.
          bindings: {
            TEST_MIGRATIONS: migrations,
            ACCESS_TEAM_DOMAIN: "contoso.cloudflareaccess.com",
            ACCESS_AUD: "test-audience-tag",
            ALLOWED_EMAIL: "reader@contoso.example",
            X_CLIENT_ID: "test-client-id",
            X_CLIENT_SECRET: "test-client-secret",
            MCP_TOKEN: "test-mcp-token-0123456789abcdef0123456789abcdef",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
