// saveWebpushPromptFn's house check, extracted as `assertSameHouse` so it can
// be unit-tested directly (createServerFn handlers can't). A tab still showing
// house A, after another tab switched the shared active house to B, must not
// save A's prompt (icon included) into B.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { assertSameHouse } from "./webpush.functions";

const HOUSE_A = "00000000-0000-4000-8000-00000000000a";
const HOUSE_B = "00000000-0000-4000-8000-00000000000b";

describe("assertSameHouse (saveWebpushPromptFn guard)", () => {
  it("formulário carregado para a casa ativa: salva normalmente", () => {
    expect(() => assertSameHouse(HOUSE_A, HOUSE_A)).not.toThrow();
  });

  it("formulário de outra casa (casa ativa trocada em outra aba): recusa sem salvar", () => {
    expect(() => assertSameHouse(HOUSE_A, HOUSE_B)).toThrow("A casa ativa mudou em outra aba");
  });
});
