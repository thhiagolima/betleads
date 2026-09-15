import { useState } from "react";
import { Copy, Phone } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const WEBHOOK_URL =
  "https://betleads.io/api/public/calls/businesscode-webhook";

export function ProvidersTab() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(WEBHOOK_URL);
      setCopied(true);
      toast.success("URL copiada");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Não foi possível copiar");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Phone className="h-5 w-5 text-primary" />
          Provedor de Telefonia
        </CardTitle>
        <CardDescription>
          Ligações disparadas pela BusinessCode usando o mesmo token configurado no SMS.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border p-4">
          <div>
            <p className="text-sm font-medium">BusinessCode Voice</p>
            <p className="text-xs text-muted-foreground">
              Endpoint: <code>dash.businesscode.com.br/api/v1/messaging/voice</code>
            </p>
          </div>
          <Badge variant="default">Ativo</Badge>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium">Webhook de callback</p>
          <p className="text-xs text-muted-foreground">
            Cadastre essa URL no painel BusinessCode para receber atualizações de status (atendida, não atendida, duração).
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-muted px-3 py-2 text-xs">
              {WEBHOOK_URL}
            </code>
            <Button size="sm" variant="outline" onClick={copy}>
              <Copy className="mr-1 h-3 w-3" />
              {copied ? "Copiado" : "Copiar"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}