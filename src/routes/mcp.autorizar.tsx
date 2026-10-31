// MCP financeiro: OAuth consent screen (authorization_endpoint, spec §5).
// Client route inside AuthGate (see __root.tsx): the Supabase session lives in
// browser storage, so a signed-out visitor sees the login form here, keeping
// the URL and its query. The request is validated by getMcpAuthorizationInfo
// before any button shows, so Cancelar only ever redirects to a registered URI.
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { approveMcpAuthorization, getMcpAuthorizationInfo } from "@/lib/mcp/oauth.functions";

type AutorizarSearch = {
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
};

// Absent params stay absent, so the router never rewrites the OAuth URL.
const str = (value: unknown) => (typeof value === "string" ? value : undefined);

export const Route = createFileRoute("/mcp/autorizar")({
  validateSearch: (search: Record<string, unknown>): AutorizarSearch => ({
    client_id: str(search.client_id),
    redirect_uri: str(search.redirect_uri),
    code_challenge: str(search.code_challenge),
    code_challenge_method: str(search.code_challenge_method),
    state: str(search.state),
  }),
  head: () => ({
    meta: [{ title: "Conectar o Claude" }, { name: "robots", content: "noindex,nofollow" }],
  }),
  component: AutorizarPage,
});

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Não foi possível carregar o pedido.";
}

function scopeList(scopes: { houses: string[]; groups: string[] }) {
  const items = [...scopes.houses, ...scopes.groups.map((nome) => `${nome} (grupo)`)];
  return items.length ? items.join(", ") : "nenhuma casa no momento";
}

function AutorizarPage() {
  const raw = Route.useSearch();
  const search = {
    client_id: raw.client_id ?? "",
    redirect_uri: raw.redirect_uri ?? "",
    code_challenge: raw.code_challenge ?? "",
    code_challenge_method: raw.code_challenge_method ?? "",
    state: raw.state ?? "",
  };
  const getInfo = useServerFn(getMcpAuthorizationInfo);
  const approve = useServerFn(approveMcpAuthorization);

  const hasRequest = Boolean(search.client_id && search.redirect_uri);
  const info = useQuery({
    queryKey: ["mcp-authorization", search.client_id, search.redirect_uri],
    queryFn: () =>
      getInfo({ data: { clientId: search.client_id, redirectUri: search.redirect_uri } }),
    enabled: hasRequest,
    retry: false,
    staleTime: Infinity,
  });

  const allow = useMutation({
    mutationFn: () =>
      approve({
        data: {
          clientId: search.client_id,
          redirectUri: search.redirect_uri,
          codeChallenge: search.code_challenge,
          codeChallengeMethod: search.code_challenge_method,
          state: search.state || undefined,
        },
      }),
    onSuccess: ({ redirectTo }) => window.location.assign(redirectTo),
  });

  function cancel() {
    const url = new URL(search.redirect_uri);
    url.searchParams.set("error", "access_denied");
    if (search.state) url.searchParams.set("state", search.state);
    window.location.assign(url.toString());
  }

  let body: React.ReactNode;
  let ready = false;
  if (!hasRequest) {
    body = <p className="text-sm text-destructive">Pedido de conexão incompleto.</p>;
  } else if (info.isPending) {
    body = <p className="text-sm text-muted-foreground">Carregando…</p>;
  } else if (info.isError) {
    body = <p className="text-sm text-destructive">{errorMessage(info.error)}</p>;
  } else {
    ready = true;
    body = (
      <div className="space-y-3 text-sm">
        <p>
          <strong>{info.data.clientName}</strong> quer acessar o financeiro de:{" "}
          {scopeList(info.data.scopes)}
        </p>
        <p className="text-muted-foreground">
          {info.data.level === "write" ? "Nível: leitura e escrita" : "Nível: leitura"}
        </p>
        {allow.isError ? <p className="text-destructive">{errorMessage(allow.error)}</p> : null}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Conectar o Claude ao financeiro</CardTitle>
        </CardHeader>
        <CardContent>{body}</CardContent>
        {ready ? (
          <CardFooter className="flex justify-end gap-2">
            <Button variant="outline" onClick={cancel} disabled={allow.isPending}>
              Cancelar
            </Button>
            <Button onClick={() => allow.mutate()} disabled={allow.isPending || allow.isSuccess}>
              Permitir
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </div>
  );
}
