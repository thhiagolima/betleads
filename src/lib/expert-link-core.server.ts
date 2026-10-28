// Núcleo da geração de link rastreado creditado a um perfil de expert
// (Área do Expert). Extraído de `generateExpertLinkFor` (Fase 2, Task 3) na
// Fase 3, Task 7, para ser usado também pelo perfil de rendimento da equipe
// (`team-expert.functions.ts`). Quem chama já resolveu a casa, o perfil e o
// jogador (cada caminho com o seu guard); aqui ficam a validação de URL e
// oferta, `assertTenantCanSendExternally`, o link (Short.io quando a casa
// tem), o insert em `expert_links` e a compensação do dispatch.
//
// expert_links (migration 20261027100000) ainda não está nos tipos gerados
// do Supabase, por isso `(supabaseAdmin as any)`.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
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

export type ExpertLinkCoreInput = {
  tenantId: string;
  expertId: string;
  playerId: string;
  url: string;
  oferta: string;
};
export type ExpertLinkCoreResult = { id: string; sentUrl: string; shortened: boolean };

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

/**
 * Gera o link rastreado de `input.playerId` creditado a `input.expertId`
 * (`link_dispatches.source_type = 'expert'`, `source_id = expertId`).
 * `tenantId`, `expertId` e `playerId` já foram autorizados pelo chamador.
 */
export async function createExpertLinkCore(
  input: ExpertLinkCoreInput,
): Promise<ExpertLinkCoreResult> {
  const url = validOfferUrl(input.url);
  const oferta = validOferta(input.oferta);
  await assertTenantCanSendExternally(input.tenantId);

  // Same uuid for the delivery key and the expert_links row: the dispatch
  // (idempotency_key "expert_links:{id}:0") points back to its row.
  const id = crypto.randomUUID();
  let link: Awaited<ReturnType<typeof createTrackedLinkForRecipient>>;
  try {
    link = await createTrackedLinkForRecipient({
      tenantId: input.tenantId,
      originalUrl: url,
      channel: "whatsapp",
      sourceType: "expert",
      sourceId: input.expertId,
      recipientPlayerId: input.playerId,
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
    tenant_id: input.tenantId,
    expert_id: input.expertId,
    player_id: input.playerId,
    link_dispatch_id: link.dispatchId,
    oferta,
    original_url: url,
    sent_url: link.sentUrl,
    shortened: link.shortened,
  });
  if (error) {
    // No orphan dispatch: a link the person never received must not be
    // tracked as sent.
    const cleanup = await db
      .from("link_dispatches")
      .delete()
      .eq("tenant_id", input.tenantId)
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
