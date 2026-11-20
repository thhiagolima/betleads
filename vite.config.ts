// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
/// <reference types="vitest/config" />
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import type { Plugin, UserConfig } from "vite";

// QA-30: TanStack Start ships a "tanstack-start-core:load-env" plugin (enforce: "pre")
// that runs `Object.assign(process.env, loadEnv(mode, root, ""))` in configResolved,
// i.e. it copies EVERY key from .env / .env.<mode> (no prefix filter) into
// process.env. Under vitest that leaked production secrets (SUPABASE_SECRET_KEY,
// SUPABASE_DB_URL, CRON_SECRET, INFOBIP_*, ...) into every test worker.
// In test mode we snapshot process.env when this config is evaluated (before any
// plugin hook runs) and restore it right after the load-env plugin, so .env files
// never reach the tests. Defense in depth lives in src/test/setup-isolation.ts.
const isVitest = Boolean(process.env.VITEST);
const processEnvBeforeConfig = isVitest ? { ...process.env } : null;

function discardDotEnvInTests(): Plugin {
  return {
    name: "betleads:discard-dotenv-in-tests",
    configResolved() {
      if (!processEnvBeforeConfig) return;
      for (const key of Object.keys(process.env)) {
        if (!(key in processEnvBeforeConfig)) delete process.env[key];
      }
      for (const [key, value] of Object.entries(processEnvBeforeConfig)) {
        if (value !== undefined) process.env[key] = value;
      }
    },
  };
}

const testConfig: UserConfig | undefined = isVitest
  ? {
      plugins: [discardDotEnvInTests()],
      test: {
        setupFiles: ["./src/test/setup-isolation.ts"],
      },
    }
  : undefined;

// OBS-03: client source maps are generated and uploaded to Sentry ONLY when
// SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT are all present at build
// time. Otherwise the build is exactly the same as before (no maps, no plugin).
// Maps are "hidden" (no sourceMappingURL comment) and deleted after upload, so
// they are never served publicly.
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN?.trim();
const sentryOrg = process.env.SENTRY_ORG?.trim();
const sentryProject = process.env.SENTRY_PROJECT?.trim();
const sentryUploadEnabled = Boolean(sentryAuthToken && sentryOrg && sentryProject);

const sentryVite = sentryUploadEnabled
  ? {
      environments: {
        client: { build: { sourcemap: "hidden" as const } },
      },
      // Only the browser bundle is uploaded; SSR/Nitro bundles are left untouched.
      plugins: [
        sentryVitePlugin({
          authToken: sentryAuthToken,
          org: sentryOrg,
          project: sentryProject,
          release: process.env.SENTRY_RELEASE?.trim()
            ? { name: process.env.SENTRY_RELEASE.trim() }
            : undefined,
          sourcemaps: {
            filesToDeleteAfterUpload: [".output/public/**/*.map", "dist/client/**/*.map"],
          },
          telemetry: false,
        }),
      ]
        .flat()
        .map((plugin) => ({
          ...plugin,
          applyToEnvironment: (environment: { name: string }) => environment.name === "client",
        })),
    }
  : undefined;

// Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
// @cloudflare/vite-plugin builds from this — wrangler.jsonc main alone is insufficient.
export default defineConfig({
  nitro: {
    preset: "node-server",
  },
  tanstackStart: {
    server: { entry: "server" },
  },
  ...(sentryVite || testConfig
    ? {
        vite: {
          ...sentryVite,
          ...testConfig,
          plugins: [...(sentryVite?.plugins ?? []), ...(testConfig?.plugins ?? [])],
        },
      }
    : {}),
});
