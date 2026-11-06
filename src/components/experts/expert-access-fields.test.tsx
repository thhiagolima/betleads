import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ExpertAccessFields } from "./expert-access-fields";
import {
  PASSWORD_IGNORED_MESSAGE,
  canSubmitExpertAccess,
  expertAccessAfterSaveError,
  expertAccessEmailError,
  expertAccessFeedback,
  expertAccessPassword,
  expertAccessPasswordError,
  type ExpertAccessMode,
} from "./expert-access-model";

const noop = () => undefined;

const fields = (mode: ExpertAccessMode, password = "") =>
  renderToStaticMarkup(
    <ExpertAccessFields
      email="e@casa.com"
      onEmailChange={noop}
      mode={mode}
      onModeChange={noop}
      password={password}
      onPasswordChange={noop}
    />,
  );

describe("ExpertAccessFields", () => {
  it("defaults to the e-mail invite without a password input", () => {
    const html = fields("convite");
    expect(html).toContain("Enviar convite por e-mail");
    expect(html).toContain("Definir senha agora");
    expect(html).not.toContain('type="password"');
  });

  it("password mode shows a hidden password input, toggle and the no-e-mail hint", () => {
    const html = fields("senha", "curta");
    expect(html).toContain('type="password"');
    expect(html).toContain("Mostrar senha");
    expect(html).toContain("A pessoa troca a senha no primeiro acesso. Nenhum e-mail é enviado.");
    expect(html).toContain("A senha precisa ter pelo menos 8 caracteres.");
  });
});

describe("expert access rules", () => {
  it("validates e-mail and password", () => {
    expect(expertAccessEmailError("")).toBeNull();
    expect(expertAccessEmailError("nope")).toBe("Informe um e-mail válido.");
    expect(expertAccessEmailError("a@b.co")).toBeNull();
    expect(expertAccessPasswordError("convite", "x")).toBeNull();
    expect(expertAccessPasswordError("senha", "1234567")).toMatch(/8 caracteres/);
    expect(expertAccessPasswordError("senha", "12345678")).toBeNull();
    expect(expertAccessPasswordError("senha", "x".repeat(201))).toMatch(/200/);
  });

  it("can submit only with a valid e-mail and, in senha mode, a valid password", () => {
    expect(canSubmitExpertAccess("", "convite", "")).toBe(false);
    expect(canSubmitExpertAccess("a@b.co", "convite", "")).toBe(true);
    expect(canSubmitExpertAccess("a@b.co", "senha", "")).toBe(false);
    expect(canSubmitExpertAccess("a@b.co", "senha", "short")).toBe(false);
    expect(canSubmitExpertAccess("a@b.co", "senha", "longenough")).toBe(true);
  });

  it("sends the password only in senha mode", () => {
    expect(expertAccessPassword("convite", "longenough")).toBeNull();
    expect(expertAccessPassword("senha", "longenough")).toBe("longenough");
  });

  it("maps the invite result to a toast", () => {
    const base = { created: true, passwordIgnored: false, invitedAgain: false };
    expect(expertAccessFeedback({ ...base, mode: "senha" })).toEqual({
      kind: "success",
      message: "Acesso criado",
    });
    expect(expertAccessFeedback({ ...base, mode: "convite" })).toEqual({
      kind: "success",
      message: "Convite enviado",
    });
    expect(
      expertAccessFeedback({ ...base, created: false, mode: "senha", passwordIgnored: true }),
    ).toEqual({ kind: "info", message: PASSWORD_IGNORED_MESSAGE });
    expect(
      expertAccessFeedback({
        created: false,
        mode: "senha",
        passwordIgnored: true,
        invitedAgain: true,
      }).message,
    ).toContain("enviamos um novo por e-mail");
  });

  it("explains a login failure after the expert was saved", () => {
    expect(expertAccessAfterSaveError("Este e-mail é de um super admin.")).toBe(
      "Expert salvo, mas o acesso não foi criado: Este e-mail é de um super admin. Use Convidar na lista.",
    );
  });
});
