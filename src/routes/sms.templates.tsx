import { createFileRoute, redirect } from "@tanstack/react-router";

// Templates de SMS viraram uma aba de /sms. O endereço antigo continua valendo.
export const Route = createFileRoute("/sms/templates")({
  beforeLoad: () => {
    throw redirect({ to: "/sms", hash: "templates" });
  },
});
