import { describe, expect, it } from "vitest";

import { loginErrorMessage } from "./auth-gate";

describe("loginErrorMessage", () => {
  it("translates Supabase errors", () => {
    expect(loginErrorMessage(new Error("Invalid login credentials"))).toBe(
      "E-mail ou senha incorretos.",
    );
    expect(loginErrorMessage(new Error("User is banned"))).toBe("Este acesso foi desativado.");
    expect(loginErrorMessage(new Error("Failed to fetch"))).toMatch(/Sem conexão/);
  });

  it("falls back to a generic message", () => {
    expect(loginErrorMessage(null)).toBe("Não foi possível entrar. Tente de novo.");
  });
});
