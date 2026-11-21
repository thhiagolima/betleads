import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

import { readPanelBalance, resolveViewerEmails } from "./sms-balance.server";

const CONFIG = { baseUrl: "http://painel.test", usuario: "conta", senha: "segredo" };

function loginResponse(location: string, cookies: string[]): Response {
  const headers = new Headers({ Location: location });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

const fetchMock = vi.fn();
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("readPanelBalance", () => {
  it("entra, manda os cookies da sessão e lê o saldo", async () => {
    fetchMock
      .mockResolvedValueOnce(
        loginResponse("lon-extrato.php", [
          "painelsms_s=deleted; expires=Thu, 01-Jan-1970 00:00:01 GMT",
          "painelsms_i=4695",
          "painelsms_u=conta",
          "painelsms_s=segredo",
        ]),
      )
      .mockResolvedValueOnce(new Response("<strong>SALDO DISPONÍVEL: 3.210 SMS(s) </strong>"));
    vi.stubGlobal("fetch", fetchMock);

    const read = await readPanelBalance(CONFIG, new Date("2026-11-21T21:00:00Z"));

    expect(read).toEqual({ result: "ok", shortcodeSms: 3210, error: null });
    const [loginUrl, loginInit] = fetchMock.mock.calls[0];
    expect(loginUrl).toBe("http://painel.test/index.php");
    expect(String(loginInit.body)).toContain("acessar_sistema=1");
    const [readUrl, readInit] = fetchMock.mock.calls[1];
    expect(readUrl).toBe("http://painel.test/rev-transferir.php");
    expect(readInit.headers.Cookie).toBe("painelsms_i=4695; painelsms_u=conta; painelsms_s=segredo");
    expect(String(readInit.body)).toContain("rs=atualiza_box_shortcode");
  });

  it("login recusado não tenta ler", async () => {
    fetchMock.mockResolvedValueOnce(
      loginResponse("index.php?erro=1", ["painelsms_s=deleted; expires=Thu, 01-Jan-1970 00:00:01 GMT"]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const read = await readPanelBalance(CONFIG);

    expect(read.result).toBe("login_failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resposta sem o saldo vira read_failed; erro de rede não lança", async () => {
    fetchMock
      .mockResolvedValueOnce(loginResponse("lon-extrato.php", ["painelsms_s=x"]))
      .mockResolvedValueOnce(new Response("<html>mudou</html>"));
    vi.stubGlobal("fetch", fetchMock);
    expect((await readPanelBalance(CONFIG)).result).toBe("read_failed");

    fetchMock.mockReset().mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await readPanelBalance(CONFIG)).toEqual({
      result: "error",
      shortcodeSms: null,
      error: "ECONNREFUSED",
    });
  });

  it("sem login configurado devolve erro sem chamar o painel", async () => {
    vi.stubGlobal("fetch", fetchMock);
    expect((await readPanelBalance(null)).result).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("resolveViewerEmails", () => {
  const users = [
    { id: "u1", email: "Ana@Casa.com" },
    { id: "u2", email: "bruno@casa.com" },
  ];

  it("acha pelo e-mail sem diferenciar maiúsculas e tira repetidos", () => {
    expect(resolveViewerEmails(["ana@casa.com", " BRUNO@casa.com ", "ana@casa.com", ""], users)).toEqual([
      "u1",
      "u2",
    ]);
  });

  it("e-mail desconhecido lança com a mensagem para a tela", () => {
    expect(() => resolveViewerEmails(["x@y.com"], users)).toThrow('Nenhum usuário do CRM com o e-mail "x@y.com".');
  });
});
