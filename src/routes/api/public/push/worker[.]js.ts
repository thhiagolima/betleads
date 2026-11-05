// Web push (OneSignal) — Task 8: serves the fixed OneSignal service worker
// file for the house to host at /push/onesignal/OneSignalSDKWorker.js.
import { createFileRoute } from "@tanstack/react-router";

import { WORKER_FILE_CONTENT } from "@/lib/webpush/shared";

export const Route = createFileRoute("/api/public/push/worker.js")({
  server: {
    handlers: {
      GET: async () =>
        new Response(WORKER_FILE_CONTENT, {
          status: 200,
          headers: {
            "Content-Type": "application/javascript",
            "Content-Disposition": 'attachment; filename="OneSignalSDKWorker.js"',
          },
        }),
    },
  },
});
