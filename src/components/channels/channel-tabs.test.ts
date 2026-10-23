import { describe, expect, it } from "vitest";

import { CHANNEL_TABS, resolveChannelHash } from "./channel-tabs";

describe("CHANNEL_TABS", () => {
  it("gives SMS and Email the same three tabs", () => {
    const values = (channel: "sms" | "email") => CHANNEL_TABS[channel].map((tab) => tab.value);
    expect(values("sms")).toEqual(["visao-geral", "templates", "historico"]);
    expect(values("email")).toEqual(values("sms"));
  });

  it("gives Voz overview, bulk send, audios and history, without flows", () => {
    expect(CHANNEL_TABS.voz.map((tab) => tab.value)).toEqual([
      "visao-geral",
      "massa",
      "audios",
      "historico",
    ]);
  });
});

describe("resolveChannelHash", () => {
  it("opens the overview for an empty or unknown hash without rewriting it", () => {
    expect(resolveChannelHash("sms", "")).toEqual({
      kind: "tab",
      tab: "visao-geral",
      canonical: true,
    });
    expect(resolveChannelHash("email", "qualquer-coisa")).toEqual({
      kind: "tab",
      tab: "visao-geral",
      canonical: true,
    });
  });

  it("opens a current tab as is, with or without the leading #", () => {
    expect(resolveChannelHash("sms", "templates")).toMatchObject({
      tab: "templates",
      canonical: true,
    });
    expect(resolveChannelHash("voz", "#massa")).toMatchObject({ tab: "massa", canonical: true });
    expect(resolveChannelHash("email", "HISTORICO")).toMatchObject({ tab: "historico" });
  });

  it.each([
    ["sms", "saude", "visao-geral"],
    ["sms", "dashboard", "visao-geral"],
    ["sms", "enviar", "visao-geral"],
    ["email", "dashboard", "visao-geral"],
    ["email", "remetentes", "visao-geral"],
    ["email", "smtp", "visao-geral"],
    ["voz", "dashboard", "visao-geral"],
    ["voz", "scripts", "audios"],
    ["voz", "fila", "historico"],
  ] as const)("maps the old %s hash %s to %s and asks to rewrite it", (channel, hash, tab) => {
    expect(resolveChannelHash(channel, hash)).toEqual({ kind: "tab", tab, canonical: false });
  });

  it("sends voice flows to Automações", () => {
    expect(resolveChannelHash("voz", "fluxos")).toEqual({
      kind: "redirect",
      redirect: { to: "/automacoes" },
    });
  });

  it("sends old campaign hashes to the campaigns hub", () => {
    expect(resolveChannelHash("sms", "campanhas")).toEqual({
      kind: "redirect",
      redirect: { to: "/campanhas" },
    });
    expect(resolveChannelHash("email", "campanhas")).toEqual({
      kind: "redirect",
      redirect: { to: "/campanhas", search: { newChannel: "email" } },
    });
    expect(resolveChannelHash("email", "automacoes")).toMatchObject({ kind: "redirect" });
  });

  it("does not leak one channel's aliases into another", () => {
    expect(resolveChannelHash("sms", "scripts")).toMatchObject({
      tab: "visao-geral",
      canonical: true,
    });
    expect(resolveChannelHash("email", "fluxos")).toMatchObject({
      kind: "tab",
      tab: "visao-geral",
    });
  });
});
