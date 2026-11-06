// Pure rules for giving an expert a login (dialogs "Convidar" and "Novo
// expert"): either an e-mail invite, or a temporary password set by the admin
// (a confirmed login, no e-mail, forced change on first sign-in). Mirrors
// `inviteExpertInput` (src/lib/experts-admin.functions.ts) so an invalid value
// never reaches the server as a raw English Zod message.

export type ExpertAccessMode = "convite" | "senha";

export const EXPERT_PASSWORD_MIN_LENGTH = 8;
export const EXPERT_PASSWORD_MAX_LENGTH = 200;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Empty = no hint yet (the submit button stays disabled). */
export function expertAccessEmailError(email: string): string | null {
  const trimmed = email.trim();
  if (!trimmed) return null;
  if (trimmed.length > 255 || !EMAIL_RE.test(trimmed)) return "Informe um e-mail válido.";
  return null;
}

/** Only checked in "senha" mode. Empty = no hint yet. */
export function expertAccessPasswordError(mode: ExpertAccessMode, password: string): string | null {
  if (mode !== "senha" || !password) return null;
  if (password.length < EXPERT_PASSWORD_MIN_LENGTH) {
    return "A senha precisa ter pelo menos 8 caracteres.";
  }
  if (password.length > EXPERT_PASSWORD_MAX_LENGTH) return "A senha pode ter até 200 caracteres.";
  return null;
}

export function canSubmitExpertAccess(
  email: string,
  mode: ExpertAccessMode,
  password: string,
): boolean {
  if (!email.trim() || expertAccessEmailError(email)) return false;
  if (mode === "senha" && (!password || expertAccessPasswordError(mode, password))) return false;
  return true;
}

/** The `inviteExpert` payload's password: only sent in "senha" mode. */
export function expertAccessPassword(mode: ExpertAccessMode, password: string): string | null {
  return mode === "senha" && password ? password : null;
}

export type ExpertInviteResult = {
  created: boolean;
  mode: ExpertAccessMode;
  passwordIgnored: boolean;
  invitedAgain: boolean;
};

export const PASSWORD_IGNORED_MESSAGE =
  "Este e-mail já tinha conta: a senha dele não foi alterada. O acesso foi vinculado.";

/** Toast after a successful `inviteExpert`. */
export function expertAccessFeedback(result: ExpertInviteResult): {
  kind: "success" | "info";
  message: string;
} {
  const reinvite = result.invitedAgain
    ? " Como a pessoa nunca aceitou o convite anterior, enviamos um novo por e-mail."
    : "";
  if (result.passwordIgnored) {
    return { kind: "info", message: PASSWORD_IGNORED_MESSAGE + reinvite };
  }
  if (result.mode === "senha") return { kind: "success", message: "Acesso criado" };
  if (result.created || result.invitedAgain) return { kind: "success", message: "Convite enviado" };
  return { kind: "success", message: "Acesso vinculado à conta que já existia" };
}

/** Error toast when the expert was saved but its login could not be created. */
export function expertAccessAfterSaveError(reason: string): string {
  const cleaned = reason.trim().replace(/[.\s]+$/, "");
  return `Expert salvo, mas o acesso não foi criado: ${cleaned}. Use Convidar na lista.`;
}
