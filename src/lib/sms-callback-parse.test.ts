import { describe, expect, it } from "vitest";
import { hasIdentity, parseSmsCallbackPayloads } from "./sms-callback-parse";

const BASE = "https://betleads.io/api/public/sms-webhook?token=secret-token";

function post(body: string, contentType: string, url = BASE) {
  return new Request(url, { method: "POST", body, headers: { "content-type": contentType } });
}

describe("parseSmsCallbackPayloads", () => {
  it("reads documented GET callbacks from the query string without the token", async () => {
    const [payload] = await parseSmsCallbackPayloads(
      new Request(`${BASE}&id=abc&parceiroId=key-1&celular=11999887766&statusOperadora=2`),
    );
    expect(payload).toEqual({
      id: "abc",
      parceiroId: "key-1",
      celular: "11999887766",
      statusOperadora: "2",
    });
  });

  it("merges query parameters into POST callbacks (POST with GET-style query)", async () => {
    const [payload] = await parseSmsCallbackPayloads(
      post("", "application/x-www-form-urlencoded", `${BASE}&id=abc&parceiroId=key-1`),
    );
    expect(payload).toMatchObject({ id: "abc", parceiroId: "key-1" });
    expect(payload).not.toHaveProperty("token");
  });

  it("reads the documented bulk JSON `{ lote: [...] }`", async () => {
    const payloads = await parseSmsCallbackPayloads(
      post(
        JSON.stringify({
          lote: [
            { id: "a", parceiroId: "k1", statusConfirmacao: "4" },
            { id: "b", parceiroId: "k2", statusOperadora: "2" },
          ],
        }),
        "application/json",
      ),
    );
    expect(payloads.map((p) => p.parceiroId)).toEqual(["k1", "k2"]);
    expect(payloads.every((p) => !("token" in p))).toBe(true);
  });

  it("reads a bare JSON array and a JSON body sent with a form content type", async () => {
    const array = await parseSmsCallbackPayloads(
      post(JSON.stringify([{ id: "a", parceiroId: "k1" }]), "text/plain"),
    );
    expect(array).toHaveLength(1);
    const mislabeled = await parseSmsCallbackPayloads(
      post(JSON.stringify({ lote: [{ id: "a", parceiroId: "k1" }] }), "application/x-www-form-urlencoded"),
    );
    expect(mislabeled[0]).toMatchObject({ id: "a", parceiroId: "k1" });
  });

  it("reads form-urlencoded fields and `lote=<json>`", async () => {
    const [form] = await parseSmsCallbackPayloads(
      post("id=a&parceiroId=k1&statusConfirmacao=4&token=leak", "application/x-www-form-urlencoded"),
    );
    expect(form).toEqual({ id: "a", parceiroId: "k1", statusConfirmacao: "4" });
    const lote = await parseSmsCallbackPayloads(
      post(
        `lote=${encodeURIComponent(JSON.stringify([{ id: "a", parceiroId: "k1" }, { id: "b", parceiroId: "k2" }]))}`,
        "application/x-www-form-urlencoded",
      ),
    );
    expect(lote.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("never returns the token, even when it is the only thing received", async () => {
    const payloads = await parseSmsCallbackPayloads(
      post("token=secret-token", "application/x-www-form-urlencoded"),
    );
    expect(payloads).toEqual([{}]);
    expect(hasIdentity(payloads[0])).toBe(false);
  });
});

describe("hasIdentity", () => {
  it("requires an id, parceiroId or phone", () => {
    expect(hasIdentity({ id: "a" })).toBe(true);
    expect(hasIdentity({ parceiroId: "k" })).toBe(true);
    expect(hasIdentity({ celular: "11999887766" })).toBe(true);
    expect(hasIdentity({ statusOperadora: "2" })).toBe(false);
    expect(hasIdentity({ id: "  " })).toBe(false);
  });
});
