import { Link, useRouterState } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import {
  LayoutDashboard,
  Users,
  Brain,
  Webhook,
  Settings,
  Sparkles,
  AlertTriangle,
  GraduationCap,
  LogOut,
  MessageSquare,
  MessageCircle,
  Zap,
  Rocket,
  Mail,
  Phone,
  ChevronRight,
  ShieldCheck,
  BarChart3,
  type LucideIcon,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useIsSuperAdmin } from "@/hooks/use-is-super-admin";
import { useWhatsappUnreadTotal } from "@/hooks/use-whatsapp-unread";
import { useAuthSession } from "@/components/auth-gate";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

type SubItem = { title: string; hash?: string; soon?: boolean };
type NavItem = {
  title: string;
  url: string;
  icon: LucideIcon;
  subItems?: SubItem[];
  soon?: boolean;
};

const menuItems: NavItem[] = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "Midia e LTV", url: "/midia-ltv", icon: BarChart3 },
  { title: "Players", url: "/players", icon: Users },
  { title: "Inteligência IA", url: "/inteligencia", icon: Brain },
  { title: "Treino IA", url: "/treino-ia", icon: GraduationCap },
  { title: "Alertas", url: "/alertas", icon: AlertTriangle },
  { title: "Regras", url: "/regras", icon: Zap },
  { title: "Automações", url: "/automacoes", icon: Rocket },
];

const engajamentoItems: NavItem[] = [
  {
    title: "WhatsApp",
    url: "/whatsapp",
    icon: MessageCircle,
    subItems: [
      { title: "Dashboard", hash: "dashboard" },
      { title: "Sessões", hash: "sessoes" },
      { title: "Fluxos", hash: "fluxos" },
      { title: "Inbox", hash: "inbox" },
      { title: "Integração externa", hash: "externo" },
    ],
  },
  {
    title: "SMS",
    url: "/sms",
    icon: MessageSquare,
    subItems: [
      { title: "Dashboard", hash: "dashboard" },
      { title: "Envio em Massa", hash: "massa" },
      { title: "Campanhas", hash: "campanhas" },
      { title: "Fluxos", hash: "fluxos" },
    ],
  },
  {
    title: "Email",
    url: "/email",
    icon: Mail,
    subItems: [
      { title: "Dashboard", hash: "dashboard" },
      { title: "Remetentes", hash: "remetentes" },
      { title: "Configurações SMTP", hash: "smtp" },
      { title: "Templates", hash: "templates" },
      { title: "Campanhas", hash: "campanhas" },
      { title: "Automações", hash: "automacoes" },
      { title: "Histórico", hash: "historico" },
    ],
  },
  {
    title: "Ligações",
    url: "/ligacoes",
    icon: Phone,
    subItems: [
      { title: "Dashboard", hash: "dashboard" },
      { title: "Fluxos", hash: "fluxos" },
      { title: "Scripts IA", hash: "scripts" },
      { title: "Envio em Massa", hash: "massa" },
      { title: "Histórico", hash: "historico" },
      { title: "Configurações", hash: "configuracoes" },
    ],
  },
  { title: "Webhooks", url: "/webhooks", icon: Webhook },
];

const sistemaItems: NavItem[] = [{ title: "Configurações", url: "/configuracoes", icon: Settings }];

const superAdminItems: NavItem[] = [
  { title: "Painel Super Admin", url: "/admin", icon: ShieldCheck },
];

function isActivePath(pathname: string, url: string) {
  return url === "/" ? pathname === "/" : pathname.startsWith(url);
}

function NavGroup({
  label,
  items,
  pathname,
  hash,
  whatsappUnread = 0,
}: {
  label: string;
  items: NavItem[];
  pathname: string;
  hash: string;
  whatsappUnread?: number;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70 font-semibold">
        {label}
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) =>
            item.subItems ? (
              <CollapsibleNavItem
                key={item.url}
                item={item}
                pathname={pathname}
                hash={hash}
                whatsappUnread={whatsappUnread}
              />
            ) : (
              <SimpleNavItem key={item.url} item={item} pathname={pathname} />
            ),
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function SimpleNavItem({ item, pathname }: { item: NavItem; pathname: string }) {
  const active = isActivePath(pathname, item.url);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        className={cn(
          "relative gap-3 transition-all duration-200",
          active &&
            "bg-gradient-to-r from-primary/15 to-accent/10 text-foreground before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:h-5 before:w-[3px] before:rounded-r-full before:bg-primary before:shadow-[0_0_8px] before:shadow-primary/60",
        )}
      >
        <Link to={item.url} className="gap-3">
          <item.icon className="h-4 w-4 shrink-0" />
          <span className="truncate">{item.title}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function CollapsibleNavItem({
  item,
  pathname,
  hash,
  whatsappUnread,
}: {
  item: NavItem;
  pathname: string;
  hash: string;
  whatsappUnread: number;
}) {
  const active = isActivePath(pathname, item.url);
  const [open, setOpen] = useState(active);
  const unread = item.url === "/whatsapp" ? whatsappUnread : 0;

  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton
            isActive={active}
            className={cn(
              "relative gap-3 transition-all duration-200 group/collapse",
              active &&
                "bg-gradient-to-r from-primary/15 to-accent/10 text-foreground before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:h-5 before:w-[3px] before:rounded-r-full before:bg-primary before:shadow-[0_0_8px] before:shadow-primary/60",
            )}
          >
            <item.icon className="h-4 w-4 shrink-0" />
            <span className="flex-1 truncate text-left">{item.title}</span>
            {unread > 0 && (
              <>
                <Badge className="h-4 min-w-4 px-1.5 text-[10px] rounded-full bg-primary text-primary-foreground shadow-[0_0_6px] shadow-primary/60 group-data-[collapsible=icon]:hidden">
                  {unread > 99 ? "99+" : unread}
                </Badge>
                <span className="hidden group-data-[collapsible=icon]:block absolute top-1 right-1 h-2 w-2 rounded-full bg-primary shadow-[0_0_6px] shadow-primary/70" />
              </>
            )}
            {item.soon && (
              <Badge
                variant="outline"
                className="h-4 px-1.5 text-[9px] uppercase tracking-wider border-accent/40 text-accent group-data-[collapsible=icon]:hidden"
              >
                Breve
              </Badge>
            )}
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[collapsible=icon]:hidden",
                open && "rotate-90",
              )}
            />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden data-[state=open]:animate-[accordion-down_180ms_ease-out] data-[state=closed]:animate-[accordion-up_180ms_ease-out]">
          <SidebarMenuSub className="border-l border-sidebar-border/80 ml-[18px] pl-3 mt-1 gap-0.5">
            {item.subItems!.map((sub) => {
              const href = sub.hash ? `${item.url}#${sub.hash}` : item.url;
              const normalizedHash = hash.replace(/^#/, "");
              const subActive =
                active && (sub.hash ? normalizedHash === sub.hash : normalizedHash === "");
              const firstSubActive =
                active && !normalizedHash && item.subItems![0]?.hash === sub.hash;
              const isOn = subActive || firstSubActive;
              return (
                <SidebarMenuSubItem key={sub.title}>
                  <SidebarMenuSubButton
                    asChild
                    isActive={isOn}
                    className={cn(
                      "relative text-[13px] transition-all duration-200",
                      isOn
                        ? "bg-gradient-to-r from-primary/20 to-accent/10 text-primary font-medium shadow-[inset_0_0_0_1px] shadow-primary/20 before:absolute before:-left-3 before:top-1/2 before:-translate-y-1/2 before:h-4 before:w-[2px] before:rounded-r-full before:bg-primary before:shadow-[0_0_6px] before:shadow-primary/70 [&_svg]:text-primary"
                        : "text-muted-foreground/80 hover:text-foreground hover:bg-sidebar-accent/40",
                    )}
                  >
                    <Link to={item.url} hash={sub.hash}>
                      <span className="truncate">{sub.title}</span>
                      {sub.soon && (
                        <span className="ml-auto text-[9px] uppercase tracking-wider text-accent/80">
                          breve
                        </span>
                      )}
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              );
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const hash = useRouterState({ select: (s) => s.location.hash });
  const session = useAuthSession();
  const { isSuperAdmin } = useIsSuperAdmin();
  const { total: whatsappUnread } = useWhatsappUnreadTotal(!!session);
  const userEmail = session?.user.email ?? null;

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarHeader className="px-4 py-5">
        <Link to="/" className="flex items-center gap-2.5">
          <div className="relative flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-accent glow-blue">
            <Sparkles className="h-4 w-4 text-primary-foreground" />
          </div>
          <div className="flex flex-col leading-none group-data-[collapsible=icon]:hidden">
            <span className="text-base font-bold tracking-tight">BETLEADS</span>
            <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Player Intelligence
            </span>
          </div>
        </Link>
      </SidebarHeader>
      <SidebarContent className="gap-1">
        <NavGroup label="Menu" items={menuItems} pathname={pathname} hash={hash} />
        <NavGroup
          label="Engajamento"
          items={engajamentoItems}
          pathname={pathname}
          hash={hash}
          whatsappUnread={whatsappUnread}
        />
        <NavGroup label="Sistema" items={sistemaItems} pathname={pathname} hash={hash} />
        {isSuperAdmin && (
          <NavGroup label="Administração" items={superAdminItems} pathname={pathname} hash={hash} />
        )}
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border p-3">
        <div className="flex items-center gap-2 rounded-md bg-sidebar-accent/40 px-2.5 py-1.5 text-xs text-muted-foreground mb-2">
          <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400 pulse-realtime" />
          <span
            className="truncate group-data-[collapsible=icon]:hidden"
            title={userEmail ?? undefined}
          >
            {userEmail ?? "Sistema online"}
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => supabase.auth.signOut()}
          className="w-full justify-start gap-2 text-xs"
        >
          <LogOut className="h-4 w-4" />
          <span className="group-data-[collapsible=icon]:hidden">Sair</span>
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}
