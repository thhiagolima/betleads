import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postInfobipSms } from "./infobip-sms.server";
import type { InfobipAccount } from "./provider-accounts.server";

const ACCOUNT: InfobipAccount = {
  id: "55555555-5555-4555-8555-555555555555",
  provider: "infobip",
  label: "Infobip Casa Um",
  baseUrl: "https://own.api.infobip.test",
  apiKey: "own-key",
  voiceFrom: "",
  smsFrom: "CasaUm",
};

function answer(status: Record<string, unknown>, http = 200) {
  return Response.json(
    { bulkId: "b-1", messages: [{ to: "5511999990000", status, messageId: "key-1" }] },
    { status: http },
  );
}

const PENDING = { groupId: 1, groupName: "PENDING", id: 26, name: "PENDING_ACCEPTED" };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => answer(PENDING));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("PUBLIC_APP_URL", "https://app.example");
  vi.stubEnv("INFOBIP_SMS_CALLBACK_TOKEN", "sms-hook-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("postInfobipSms", () => {
  it("sends one message correlated by our key, with the sender and the delivery-report URL", async () => {
    const r = await postInfobipSms(ACCOUNT, "+55 11 99999-0000", "Oi João", "key-1");

    expect(r).toMatchObject({
      ok: true,
      providerMessageId: "key-1",
      providerAccountId: ACCOUNT.id,
      accountReason: null,
      errorSummary: null,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://own.api.infobip.test/sms/2/text/advanced");
    expect((init.headers as Record<string, string>).Authorization).toBe("App own-key");
    expect(JSON.parse(String(init.body))).toEqual({
      messages: [
        {
          destinations: [{ to: "5511999990000", messageId: "key-1" }],
          from: "CasaUm",
          text: "Oi João",
          callbackData: "key-1",
          notifyUrl: "https://app.example/api/public/infobip/sms/events?token=sms-hook-token",
          notifyContentType: "application/json",
        },
      ],
    });
  });

  it("an account without credits is an account refusal (opens that account's breaker)", async () => {
    fetchMock.mockResolvedValueOnce(
      answer({
        groupId: 5,
        groupName: "REJECTED",
        id: 12,
        name: "REJECTED_NOT_ENOUGH_CREDITS",
        description: "Not enough credits",
      }),
    );
    const r = await postInfobipSms(ACCOUNT, "+5511999990000", "x", "key-1");
    expect(r).toMatchObject({ ok: false, status: 200, accountReason: "no_balance" });
    expect(r.errorSummary).toMatch(/sem crédito/);
  });

  it("refused credentials are an account refusal; a refused number is not", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { requestError: { serviceException: { text: "Invalid login details" } } },
        { status: 401 },
      ),
    );
    expect(await postInfobipSms(ACCOUNT, "+5511999990000", "x")).toMatchObject({
      ok: false,
      status: 401,
      accountReason: "auth",
    });

    fetchMock.mockResolvedValueOnce(
      answer({
        groupId: 5,
        groupName: "REJECTED",
        id: 6,
        name: "REJECTED_DESTINATION",
        description: "Invalid destination",
      }),
    );
    const r = await postInfobipSms(ACCOUNT, "+5511999990000", "x");
    expect(r).toMatchObject({ ok: false, accountReason: null });
    expect(r.errorSummary).toBe("Infobip recusou o SMS: Invalid destination");
  });

  it("retries only a request that never left; a timeout is outcome unknown, never resent", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    fetchMock.mockRejectedValueOnce(refused).mockResolvedValueOnce(answer(PENDING));
    expect((await postInfobipSms(ACCOUNT, "+5511999990000", "x", "key-1")).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset();
    fetchMock.mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
    const r = await postInfobipSms(ACCOUNT, "+5511999990000", "x", "key-2");
    expect(r).toMatchObject({ ok: false, status: 0, errorKind: "outcome_unknown" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an account without URL or key is misconfigured and nothing is sent", async () => {
    const r = await postInfobipSms({ ...ACCOUNT, apiKey: "" }, "+5511999990000", "x");
    expect(r).toMatchObject({ ok: false, errorKind: "misconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
