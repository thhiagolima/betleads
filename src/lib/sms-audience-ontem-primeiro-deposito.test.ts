/* eslint-disable @typescript-eslint/no-explicit-any -- dublê mínimo do cliente. */
import { describe, expect, it } from "vitest";
import { criteriaLabels } from "@/components/audiences/criteria-labels";
import {
  describeSmsAudience,
  hasNoAudienceRules,
  normalizeSmsAudienceCriteria,
} from "./sms-audience-criteria";
import { resolveAudienceForTenant } from "./sms-audience-selection.server";

const TENANT = "00000000-0000-4000-8000-00000000a001";

/** RPC falso: `flags` simula o banco com (true) ou sem (ausente) a migration nova. */
function rpcDb(flags: Record<string, unknown>) {
  const calls: Array<Record<string, unknown>> = [];
  const db: any = {
    from: () => {
      throw new Error("não deveria ler tabelas");
    },
    rpc: (_fn: string, args: { _criteria: Record<string, unknown> }) => {
      calls.push(args._criteria);
      return Promise.resolve({
        data: {
          phones: [],
          total: 0,
          recipientTotal: 0,
          emailPlayerIds: [],
          emailRecipientTotal: 0,
          facets: {},
          settings: { thresholds: {}, cooling: 2, sleeping: 7 },
          ...flags,
        },
        error: null,
      });
    },
  };
  return { db, calls };
}

describe("público: cadastrou ontem e só o 1º depósito", () => {
  it("normaliza e descreve as regras novas", () => {
    const criteria = normalizeSmsAudienceCriteria({
      activity: { deposit: "never" },
      registeredYesterday: true,
    });
    expect(criteria.registeredYesterday).toBe(true);
    expect(hasNoAudienceRules(normalizeSmsAudienceCriteria({ registeredYesterday: true }))).toBe(
      false,
    );
    expect(describeSmsAudience(criteria)).toBe("nunca depositou · cadastrou ontem");
    expect(criteriaLabels(criteria)).toEqual(["Nunca depositou", "Cadastrou ontem"]);

    const first = normalizeSmsAudienceCriteria({ activity: { deposit: "first_only" } });
    expect(first.activity.deposit).toBe("first_only");
    expect(criteriaLabels(first)).toEqual(["Só fez o 1º depósito"]);
  });

  it("envia as regras ao RPC e aceita quando o banco confirma o filtro", async () => {
    const { db, calls } = rpcDb({ firstDepositFilter: true, registeredYesterdayFilter: true });
    await resolveAudienceForTenant(db, TENANT, {
      activity: { deposit: "first_only" },
      registeredYesterday: true,
    });
    expect(calls[0]).toMatchObject({
      activity: { deposit: "first_only" },
      registeredYesterday: true,
    });
  });

  it("falha fechado com o RPC anterior (sem as flags), em vez de mandar para todos", async () => {
    const { db } = rpcDb({});
    await expect(
      resolveAudienceForTenant(db, TENANT, { registeredYesterday: true }),
    ).rejects.toThrow("Cadastrou ontem ainda não está disponível");
    await expect(
      resolveAudienceForTenant(db, TENANT, { activity: { deposit: "first_only" } }),
    ).rejects.toThrow("Só fez o 1º depósito ainda não está disponível");
    // Regras antigas seguem funcionando com o RPC anterior.
    await expect(
      resolveAudienceForTenant(db, TENANT, { activity: { deposit: "yes" } }),
    ).resolves.toBeTruthy();
  });
});
