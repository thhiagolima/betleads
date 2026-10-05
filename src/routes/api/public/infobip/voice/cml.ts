import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";

function authorized(request: Request): boolean {
  const expected = process.env.INFOBIP_VOICE_CALLBACK_TOKEN;
  const received = new URL(request.url).searchParams.get("token");
  if (!expected || !received || expected.length !== received.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

export const Route = createFileRoute("/api/public/infobip/voice/cml")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
        const audio = new URL(request.url).searchParams.get("audio");
        if (!audio || !/^https:\/\//i.test(audio)) {
          return Response.json({ error: "invalid audio" }, { status: 400 });
        }
        return Response.json({
          actions: [
            { action: "play", content: { type: "URL", fileUrl: audio } },
            { action: "hangup" },
          ],
        });
      },
    },
  },
});
