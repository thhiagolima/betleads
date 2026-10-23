import { describe, expect, it } from "vitest";

import { emailEventStatus } from "./email-event-status";

describe("emailEventStatus", () => {
  it("never claims delivery: delivered reads as sent", () => {
    expect(emailEventStatus("delivered")).toEqual({ color: "green", label: "Enviado" });
    expect(emailEventStatus("sent")).toEqual({ color: "green", label: "Enviado" });
  });

  it("translates failures, pending and unknown statuses", () => {
    expect(emailEventStatus("dlq")).toEqual({ color: "red", label: "Falha" });
    expect(emailEventStatus("bounced").label).toBe("Devolvido");
    expect(emailEventStatus("PENDING").color).toBe("yellow");
    expect(emailEventStatus(null)).toEqual({ color: "gray", label: "Outro" });
  });
});
