import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
  useRouterState: () => "",
}));

vi.mock("@tanstack/react-start", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-start")>();
  return { ...actual, useServerFn: (fn: unknown) => fn };
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: false, isSuccess: false, isError: false }),
  useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("./journey-status-control", () => ({
  useJourneyStatusControl: () => ({
    requestActivate: vi.fn(),
    requestPause: vi.fn(),
    isPending: false,
    dialogs: null,
  }),
}));

vi.mock("@/components/system-dialog-host", () => ({
  requestConfirmation: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { storage: { from: () => ({ uploadToSignedUrl: vi.fn() }) } },
}));

const enabledChannels: { isEnabled: (channel: string) => boolean } = {
  isEnabled: () => true,
};

vi.mock("@/hooks/use-enabled-channels", () => ({
  useEnabledChannels: () => enabledChannels,
}));

// Radix's DropdownMenuContent only renders when open, which never happens in
// a static (SSR) render — stub with plain pass-through markup so the
// "Adicionar etapa" menu items are visible to the test.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { JourneyEditor } from "./journey-editor";

describe("JourneyEditor — canais desligados", () => {
  it("não lista Voz no dropdown de adicionar etapa quando voz está desligada", () => {
    enabledChannels.isEnabled = (channel) => channel !== "voice";
    const html = renderToStaticMarkup(<JourneyEditor initialSteps={[]} />);
    expect(html).not.toContain("Ligação (voz)");
    expect(html).toContain("SMS");
    expect(html).toContain("E-mail");
  });

  it("mostra o selo de desabilitado num passo de voz existente e esconde a edição", () => {
    enabledChannels.isEnabled = (channel) => channel !== "voice";
    const html = renderToStaticMarkup(
      <JourneyEditor
        initialSteps={[
          {
            step_type: "voice",
            config: { asset_id: "asset-1", caller_id: "123" },
            is_enabled: true,
          },
        ]}
      />,
    );
    expect(html).toContain("Canal desabilitado — será pulado");
    expect(html).not.toContain("Áudio da ligação");
  });

  it("lista todos os canais quando todos estão ligados", () => {
    enabledChannels.isEnabled = () => true;
    const html = renderToStaticMarkup(<JourneyEditor initialSteps={[]} />);
    expect(html).toContain("Ligação (voz)");
  });
});
