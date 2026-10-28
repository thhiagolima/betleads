// Super admin's "Ver:" picker (spec §4): "Todas as casas", then each group,
// then each house, from listDashboardScopes. A scope is encoded as a Select
// value ("all", "group:<id>", "tenant:<id>") by ./scope.
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listDashboardScopes, type DashboardScope } from "@/lib/finance-dashboard.functions";

import { scopeToValue, valueToScope, withCurrentScope } from "./scope";

export function ScopePicker({
  value,
  currentLabel,
  onChange,
}: {
  value: DashboardScope;
  /** The dashboard's label of `value`, shown when `value` is not in the list. */
  currentLabel?: string;
  onChange: (next: DashboardScope) => void;
}) {
  const listScopes = useServerFn(listDashboardScopes);
  const query = useQuery({
    queryKey: ["finance-dashboard-scopes"],
    queryFn: () => listScopes(),
    staleTime: 5 * 60_000,
  });
  const { groups, tenants } = withCurrentScope(
    { groups: query.data?.groups ?? [], tenants: query.data?.tenants ?? [] },
    value,
    currentLabel,
  );

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Ver:</span>
      <Select value={scopeToValue(value)} onValueChange={(next) => onChange(valueToScope(next))}>
        <SelectTrigger className="h-8 w-full max-w-xs text-xs sm:w-64">
          <SelectValue placeholder="Todas as casas" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Todas as casas</SelectItem>
          {groups.length > 0 && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Grupos</SelectLabel>
                {groups.map((group) => (
                  <SelectItem key={group.id} value={`group:${group.id}`}>
                    {group.nome}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          )}
          {tenants.length > 0 && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Casas</SelectLabel>
                {tenants.map((tenant) => (
                  <SelectItem key={tenant.id} value={`tenant:${tenant.id}`}>
                    {tenant.nome}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
