// Small display helpers shared by the admin Experts list (experts.tsx) and
// detail (experts.$expertId.tsx) pages — pulled out of the route files so
// each one only exports its component (fast refresh) and so the detail page
// doesn't need to import from a sibling route module.
import { Badge } from "@/components/ui/badge";
import type { ExpertAcesso, ExpertAdminRow } from "@/lib/experts-admin.functions";

export const TIPO_LABEL: Record<ExpertAdminRow["tipo"], string> = {
  restrito: "Restrito",
  total: "Acesso total",
};

export const PAPEL_EQUIPE_LABEL: Record<NonNullable<ExpertAdminRow["papelEquipe"]>, string> = {
  admin: "Admin",
  gestor: "Gestor",
  member: "Membro",
};

export function acessoBadge(
  acesso: ExpertAcesso,
  papelEquipe: ExpertAdminRow["papelEquipe"] = null,
) {
  switch (acesso) {
    case "equipe":
      return (
        <Badge variant="secondary">
          {papelEquipe ? `Equipe (${PAPEL_EQUIPE_LABEL[papelEquipe]})` : "Equipe"}
        </Badge>
      );
    case "sem_acesso":
      return <Badge variant="outline">Sem acesso</Badge>;
    case "convite_pendente":
      return <Badge className="bg-info/15 text-info">Convite pendente</Badge>;
    case "ativo":
      return <Badge className="bg-success/15 text-success">Ativo</Badge>;
    case "inativo":
      return <Badge variant="destructive">Inativo</Badge>;
  }
}
