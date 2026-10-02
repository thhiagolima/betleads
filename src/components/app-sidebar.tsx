import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Brain,
  Building2,
  LayoutDashboard,
  LogOut,
  Megaphone,
  MessageSquare,
  Rocket,
  Settings,
  ShieldCheck,
  Sparkles,
  Trophy,
  Users,
  Webhook,
  X,
  type LucideIcon,
} from "lucide-react";

import { useAuthSession } from "@/components/auth-gate";
import {
  Sidebar,
  SidebarFooter,
  SidebarHeader,
  SidebarItem,
  SidebarNav,
  SidebarNested,
  SidebarSection,
  SidebarToggle,
  useSidebar,
} from "@/components/ui/sidebar";
import { useIsSuperAdmin } from "@/hooks/use-is-super-admin";
import { useWhatsappUnreadTotal } from "@/hooks/use-whatsapp-unread";
import { supabase } from "@/integrations/supabase/client";

type SubItem = { title: string; hash?: string; url?: string; soon?: boolean };
type NavItem = {
  title: string;
  url: string;
  icon: LucideIcon;
  subItems?: SubItem[];
};

const overviewItems: NavItem[] = [
  { title: "Início", url: "/", icon: LayoutDashboard },
  { title: "Aquisição e LTV", url: "/midia-ltv", icon: BarChart3 },
];

const crmItems: NavItem[] = [
  { title: "Jogadores", url: "/players", icon: Users },
  { title: "Públicos", url: "/publicos", icon: Users },
  { title: "Oportunidades", url: "/alertas", icon: AlertTriangle },
  { title: "Níveis e fidelização", url: "/gamificacao", icon: Trophy },
];

const engagementItems: NavItem[] = [
  { title: "Campanhas", url: "/campanhas", icon: Megaphone },
  {
    title: "Automações",
    url: "/automacoes",
    icon: Rocket,
    subItems: [
      { title: "Visão geral", hash: "visao-geral" },
      { title: "Fluxos", url: "/automacoes/sms" },
      { title: "Execuções", hash: "execucoes" },
      { title: "Histórico", hash: "historico" },
    ],
  },
  {
    title: "Canais",
    url: "/whatsapp",
    icon: MessageSquare,
    subItems: [
      { title: "WhatsApp", url: "/whatsapp" },
      { title: "SMS", url: "/sms" },
      { title: "Email", url: "/email" },
      { title: "Ligações", url: "/ligacoes" },
    ],
  },
];

const intelligenceItems: NavItem[] = [
  {
    title: "Inteligência",
    url: "/inteligencia",
    icon: Brain,
    subItems: [
      { title: "Assistente IA", url: "/inteligencia" },
      { title: "Configurar IA", url: "/treino-ia" },
    ],
  },
];

const systemItems: NavItem[] = [
  { title: "Integrações", url: "/webhooks", icon: Webhook },
  { title: "Configurações", url: "/configuracoes", icon: Settings },
];
const tenantItem: NavItem = { title: "Conta e equipe", url: "/tenants", icon: Building2 };
const adminItems: NavItem[] = [
  { title: "Visão da plataforma", url: "/admin", icon: ShieldCheck },
  { title: "Contas", url: "/tenants", icon: Building2 },
];

function isActivePath(pathname: string, url: string) {
  return url === "/" ? pathname === "/" : pathname.startsWith(url);
}

function CountBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md bg-foreground/[0.07] px-1.5 py-0.5 text-[10.5px] font-medium leading-none tabular-nums text-muted-foreground">
      {children}
    </span>
  );
}

function SimpleItem({ item, pathname }: { item: NavItem; pathname: string }) {
  return (
    <SidebarItem
      asChild
      active={isActivePath(pathname, item.url)}
      icon={<item.icon className="size-[18px]" strokeWidth={1.75} />}
    >
      <Link to={item.url}>{item.title}</Link>
    </SidebarItem>
  );
}

function NestedItem({
  item,
  pathname,
  hash,
  unread,
}: {
  item: NavItem;
  pathname: string;
  hash: string;
  unread: number;
}) {
  const active = isActivePath(pathname, item.url) || Boolean(
    item.subItems?.some((sub) => sub.url && isActivePath(pathname, sub.url)),
  );
  const [open, setOpen] = useState(active);
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);

  return (
    <SidebarNested
      label={item.title}
      icon={<item.icon className="size-[18px]" strokeWidth={1.75} />}
      active={active}
      open={open}
      onOpenChange={setOpen}
      badge={unread > 0 ? <CountBadge>{unread > 99 ? "99+" : unread}</CountBadge> : undefined}
    >
      {item.subItems?.map((sub, index) => {
        const normalizedHash = hash.replace(/^#/, "");
        const subActive = sub.url
          ? isActivePath(pathname, sub.url)
          : active && (normalizedHash === sub.hash || (!normalizedHash && index === 0));
        return (
          <SidebarItem
            key={sub.title}
            asChild
            active={subActive}
            className="py-[7px] text-[12.5px]"
          >
            <Link to={sub.url ?? item.url} hash={sub.url ? undefined : sub.hash}>
              {sub.title}
            </Link>
          </SidebarItem>
        );
      })}
    </SidebarNested>
  );
}

function NavSection({
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
    <SidebarSection label={label}>
      {items.map((item) =>
        item.subItems ? (
          <NestedItem
            key={item.url}
            item={item}
            pathname={pathname}
            hash={hash}
            unread={item.url === "/whatsapp" ? whatsappUnread : 0}
          />
        ) : (
          <SimpleItem key={item.url} item={item} pathname={pathname} />
        ),
      )}
    </SidebarSection>
  );
}

function Brand() {
  const { collapsed } = useSidebar();
  return (
    <Link to="/" className="flex min-w-0 items-center gap-2.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-[0_0_18px] shadow-primary/25">
        <Sparkles className="size-3.5" />
      </span>
      {!collapsed && (
        <span className="min-w-0">
          <span className="block truncate text-[13.5px] font-semibold leading-none">BETLEADS</span>
          <span className="mt-1 block truncate text-[9px] uppercase leading-none tracking-[0.15em] text-muted-foreground">
            Player Intelligence
          </span>
        </span>
      )}
    </Link>
  );
}

function UserFooter({ email }: { email: string | null }) {
  const { collapsed } = useSidebar();
  const initials = email?.slice(0, 2).toUpperCase() ?? "BL";
  return (
    <>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
        {initials}
      </span>
      {!collapsed && (
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium">{email ?? "Sistema online"}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-emerald-400" /> Online
          </div>
        </div>
      )}
      {!collapsed && (
        <button
          type="button"
          onClick={() => supabase.auth.signOut()}
          className="flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          aria-label="Sair"
        >
          <LogOut className="size-4" />
        </button>
      )}
    </>
  );
}

export function AppSidebar({
  collapsed,
  onCollapsedChange,
  mobile = false,
  mobileOpen = false,
  onMobileClose,
}: {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  mobile?: boolean;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const hash = useRouterState({ select: (state) => state.location.hash });
  const session = useAuthSession();
  const { isSuperAdmin } = useIsSuperAdmin();
  const { total: whatsappUnread } = useWhatsappUnreadTotal(Boolean(session));
  const tenantSystemItems = isSuperAdmin ? systemItems : [...systemItems, tenantItem];

  return (
    <Sidebar
      variant="collapsible"
      className={`fixed inset-y-0 left-0 z-50 h-dvh transition-transform duration-200 md:translate-x-0 ${
        mobile && !mobileOpen ? "-translate-x-full" : "translate-x-0"
      }`}
      width={244}
      collapsedWidth={60}
      collapsed={collapsed}
      onCollapsedChange={onCollapsedChange}
    >
      <SidebarHeader>
        <Brand />
        {mobile ? (
          <button
            type="button"
            aria-label="Fechar menu"
            onClick={onMobileClose}
            className="ml-auto flex size-8 items-center justify-center rounded-[10px] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <X className="size-[17px]" />
          </button>
        ) : (
          <SidebarToggle className="ml-auto" />
        )}
      </SidebarHeader>
      <SidebarNav>
        <NavSection label="Visão geral" items={overviewItems} pathname={pathname} hash={hash} />
        <NavSection label="CRM" items={crmItems} pathname={pathname} hash={hash} />
        <NavSection
          label="Engajamento"
          items={engagementItems}
          pathname={pathname}
          hash={hash}
          whatsappUnread={whatsappUnread}
        />
        <NavSection label="Inteligência" items={intelligenceItems} pathname={pathname} hash={hash} />
        <NavSection label="Configurações" items={tenantSystemItems} pathname={pathname} hash={hash} />
        {isSuperAdmin && (
          <NavSection label="Administração" items={adminItems} pathname={pathname} hash={hash} />
        )}
      </SidebarNav>
      <SidebarFooter>
        <UserFooter email={session?.user.email ?? null} />
      </SidebarFooter>
    </Sidebar>
  );
}
