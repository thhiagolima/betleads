// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { sentryVitePlugin } from "@sentry/vite-plugin";

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
  ...(sentryVite ? { vite: sentryVite } : {}),
});
