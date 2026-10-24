// Link rastreado por lead na Área do Expert (Fase 2, Task 3): o expert cola o
// link de bônus do backoffice da casa e recebe um link rastreado (encurtado
// no Short.io quando a casa tem) para mandar pelo próprio WhatsApp.
//
// Fluxo: validação -> requireExpertContext -> loadVisibleLead (guard de
// alcance) -> assertTenantCanSendExternally -> createTrackedLinkForRecipient
// -> insert em expert_links. expert_links (migration 20261027100000) ainda
// não está nos tipos gerados do Supabase, por isso `(supabaseAdmin as any)`.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireExpertContext } from "@/lib/expert-access.server";
import { loadVisibleLead } from "@/lib/expert-lead-access.server";
import {
  createTrackedLinkForRecipient,
  DestinationNotAllowedError,
  ShortenerUnavailableError,
} from "@/lib/shortio.server";
import { assertTenantCanSendExternally } from "@/lib/tenant-access.server";

const MAX_URL_LENGTH = 2048;
const INVALID_URL = "Cole um link válido começando com http:// ou https://.";
const INVALID_OFERTA = "Dê um nome à oferta (2 a 60 caracteres).";
const SHORTENER_UNAVAILABLE = "Não foi possível encurtar o link agora. Tente de novo.";
const DESTINATION_NOT_ALLOWED =
  "Este link não é permitido pela casa. Use o link do backoffice da casa.";

type ServerContext = {
  userId: string;
  activeTenantId?: string | null;
};

export type GenerateExpertLinkInput = { playerId: string; url: string; oferta: string };
export type GeneratedExpertLink = { id: string; sentUrl: string; shortened: boolean };

const generateInput = z.object({
  playerId: z.string().uuid(),
  url: z.string(),
  oferta: z.string(),
});

export const generateExpertLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => generateInput.parse(data))
  .handler(async ({ data, context }) =>
    generateExpertLinkFor(context as unknown as ServerContext, data),
  );

/** URL http(s) absoluta de até 2048 caracteres, sem espaços nas pontas. */
function validOfferUrl(raw: string): string {
  const url = raw.trim();
  if (url.length === 0 || url.length > MAX_URL_LENGTH) throw new Error(INVALID_URL);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(INVALID_URL);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(INVALID_URL);
  return url;
}

function validOferta(raw: string): string {
  const oferta = raw.trim();
  if (oferta.length < 2 || oferta.length > 60) throw new Error(INVALID_OFERTA);
  return oferta;
}

/** Body of `generateExpertLink`, exported so it is directly unit-testable. */
export async function generateExpertLinkFor(
  ctx: ServerContext,
  data: GenerateExpertLinkInput,
): Promise<GeneratedExpertLink> {
  const url = validOfferUrl(data.url);
  const oferta = validOferta(data.oferta);

  const expert = await requireExpertContext(ctx.userId, ctx.activeTenantId);
  const lead = await loadVisibleLead(expert, data.playerId);
  await assertTenantCanSendExternally(expert.tenantId);

  // Same uuid for the delivery key and the expert_links row: the dispatch
  // (idempotency_key "expert_links:{id}:0") points back to its row.
  const id = crypto.randomUUID();
  let link: Awaited<ReturnType<typeof createTrackedLinkForRecipient>>;
  try {
    link = await createTrackedLinkForRecipient({
      tenantId: expert.tenantId,
      originalUrl: url,
      channel: "whatsapp",
      sourceType: "expert",
      sourceId: expert.expertId,
      recipientPlayerId: lead.id,
      deliveryKey: `expert_links:${id}`,
    });
  } catch (error) {
    if (error instanceof ShortenerUnavailableError) throw new Error(SHORTENER_UNAVAILABLE);
    if (error instanceof DestinationNotAllowedError) throw new Error(DESTINATION_NOT_ALLOWED);
    throw error;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- expert_links is not in the generated types yet
  const db = supabaseAdmin as any;
  const { error } = await db.from("expert_links").insert({
    id,
    tenant_id: expert.tenantId,
    expert_id: expert.expertId,
    player_id: lead.id,
    link_dispatch_id: link.dispatchId,
    oferta,
    original_url: url,
    sent_url: link.sentUrl,
    shortened: link.shortened,
  });
  if (error) {
    // No orphan dispatch: a link the expert never received must not be
    // tracked as sent.
    const cleanup = await db
      .from("link_dispatches")
      .delete()
      .eq("tenant_id", expert.tenantId)
      .eq("id", link.dispatchId);
    if (cleanup.error)
      console.error("[expert-links] orphan dispatch cleanup failed", {
        dispatchId: link.dispatchId,
        error: cleanup.error.message,
      });
    throw new Error(error.message);
  }

  return { id, sentUrl: link.sentUrl, shortened: link.shortened };
}
