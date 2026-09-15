import { createFileRoute } from "@tanstack/react-router";

// Legacy route without a tenant token.
// Kept only to return a controlled response; it must not process events.
export const Route = createFileRoute("/api/public/webhook/$evento")({
  server: {
    handlers: {
      POST: async ({
        request,
        params,
      }: {
        request: Request;
        params: { evento: string };
      }) => {
        void request;
        return Response.json(
          {
            ok: false,
            evento: params.evento,
            error: "URL legada desativada. Use /api/public/webhook/{token}/{evento}.",
          },
          { status: 410 },
        );
      },
    },
  },
});
