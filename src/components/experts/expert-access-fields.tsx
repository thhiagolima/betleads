// E-mail + "how to give access" choice + temporary password, shared by the
// "Convidar" dialog and the "Acesso (opcional)" section of "Novo expert".
// Rules live in expert-access-model.ts.
import { useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  EXPERT_PASSWORD_MAX_LENGTH,
  expertAccessEmailError,
  expertAccessPasswordError,
  type ExpertAccessMode,
} from "@/components/experts/expert-access-model";

export function ExpertAccessFields({
  email,
  onEmailChange,
  mode,
  onModeChange,
  password,
  onPasswordChange,
  emailLabel = "E-mail",
  emailOptional = false,
}: {
  email: string;
  onEmailChange: (value: string) => void;
  mode: ExpertAccessMode;
  onModeChange: (mode: ExpertAccessMode) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  emailLabel?: string;
  /** "Novo expert": the access step is optional, so the mode only matters with an e-mail. */
  emailOptional?: boolean;
}) {
  const fieldId = useId();
  const ids = {
    email: `${fieldId}-email`,
    convite: `${fieldId}-convite`,
    senha: `${fieldId}-senha`,
    password: `${fieldId}-password`,
    passwordHelp: `${fieldId}-password-help`,
    passwordError: `${fieldId}-password-error`,
  };
  const [showPassword, setShowPassword] = useState(false);
  const emailHint = expertAccessEmailError(email);
  const passwordHint = expertAccessPasswordError(mode, password);

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor={ids.email}>{emailLabel}</Label>
        <Input
          id={ids.email}
          type="email"
          value={email}
          onChange={(e) => onEmailChange(e.target.value)}
          placeholder="expert@exemplo.com"
          maxLength={255}
          autoComplete="off"
        />
        {emailHint ? (
          <p className="text-xs text-destructive">{emailHint}</p>
        ) : (
          emailOptional && (
            <p className="text-xs text-muted-foreground">
              Deixe vazio para cadastrar sem acesso agora (dá para usar Convidar na lista depois).
            </p>
          )
        )}
      </div>

      <RadioGroup
        value={mode}
        onValueChange={(value) => onModeChange(value as ExpertAccessMode)}
        aria-label="Como dar o acesso"
      >
        <div className="flex items-center gap-2">
          <RadioGroupItem value="convite" id={ids.convite} />
          <Label htmlFor={ids.convite} className="cursor-pointer font-normal">
            Enviar convite por e-mail
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="senha" id={ids.senha} />
          <Label htmlFor={ids.senha} className="cursor-pointer font-normal">
            Definir senha agora
          </Label>
        </div>
      </RadioGroup>

      {mode === "senha" && (
        <div className="space-y-2">
          <Label htmlFor={ids.password}>Senha temporária</Label>
          <div className="relative">
            <Input
              id={ids.password}
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => onPasswordChange(e.target.value)}
              placeholder="mínimo 8 caracteres"
              maxLength={EXPERT_PASSWORD_MAX_LENGTH}
              autoComplete="new-password"
              className="pr-10"
              aria-invalid={!!passwordHint}
              aria-describedby={
                passwordHint ? `${ids.passwordHelp} ${ids.passwordError}` : ids.passwordHelp
              }
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
              className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <p id={ids.passwordHelp} className="text-xs text-muted-foreground">
            A pessoa troca a senha no primeiro acesso. Nenhum e-mail é enviado. Se o e-mail já tiver
            conta, a senha dele não é alterada.
          </p>
          {passwordHint && (
            <p id={ids.passwordError} className="text-xs text-destructive">
              {passwordHint}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
