// One popup public service per server process, so the 60 s tenant cache is
// shared by the popup list and the event endpoints.
import { createPopupPublicService } from "@/lib/popups/public.server";
import type { PopupsDb } from "@/lib/popups/popups.server";

let service: ReturnType<typeof createPopupPublicService> | null = null;

export function popupPublicService(db: unknown): ReturnType<typeof createPopupPublicService> {
  if (!service) service = createPopupPublicService(db as PopupsDb);
  return service;
}
