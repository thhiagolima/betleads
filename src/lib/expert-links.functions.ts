// Link rastreado por lead na Área do Expert (Fase 2, Task 3): o expert cola o
// link de bônus do backoffice da casa e recebe um link rastreado (encurtado
// no Short.io quando a casa tem) para mandar pelo próprio WhatsApp.
//
// Fluxo: requireExpertContext -> loadVisibleLead (guard de alcance) ->
// createExpertLinkCore (validação de URL e oferta,
// assertTenantCanSendExternally, link, insert em expert_links e compensação;
// núcleo compartilhado com o perfil de rendimento da equipe, Fase 3 Task 7).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requireExpertContext } from "@/lib/expert-access.server";
import { createExpertLinkCore } from "@/lib/expert-link-core.server";
import { loadVisibleLead } from "@/lib/expert-lead-access.server";

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

/** Body of `generateExpertLink`, exported so it is directly unit-testable. */
export async function generateExpertLinkFor(
  ctx: ServerContext,
  data: GenerateExpertLinkInput,
): Promise<GeneratedExpertLink> {
  const expert = await requireExpertContext(ctx.userId, ctx.activeTenantId);
  const lead = await loadVisibleLead(expert, data.playerId);
  return createExpertLinkCore({
    tenantId: expert.tenantId,
    expertId: expert.expertId,
    playerId: lead.id,
    url: data.url,
    oferta: data.oferta,
  });
}
