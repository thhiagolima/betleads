// Inserts the house URL / quick-link message variables ({link},
// {link_<key>}) into a composer's SMS text or e-mail HTML at the cursor.
// Used by the campaign composer and the journey editor's SMS/e-mail steps.
import type { RefObject } from "react";

import { Badge } from "@/components/ui/badge";

export type LinkInsertQuickLink = { key: string; label: string; url: string };
export type LinkInsertItem = { label: string; token: string };

/** Inserts `token` at the current selection of a text field, replacing any
 * selected range. Pure — no DOM access — so it's unit-testable without
 * jsdom. Falls back to the end of `text` when a cursor position isn't a
 * finite number (e.g. a ref not yet attached). */
export function insertAtCursor(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  token: string,
): { text: string; cursor: number } {
  const start = Number.isFinite(selectionStart) ? selectionStart : text.length;
  const end = Number.isFinite(selectionEnd) ? selectionEnd : text.length;
  const next = text.slice(0, start) + token + text.slice(end);
  return { text: next, cursor: start + token.length };
}

/** The insertable link items: the house URL first, then every quick link —
 * each with the message-variable token it inserts. Empty when the house has
 * no site URL yet; callers show the "cadastre a URL" notice instead. */
export function linkInsertItems(options: {
  siteUrl: string | null;
  quickLinks: LinkInsertQuickLink[];
}): LinkInsertItem[] {
  if (!options.siteUrl) return [];
  return [
    { label: "URL da casa", token: "{link}" },
    ...options.quickLinks.map((link) => ({ label: link.label, token: `{link_${link.key}}` })),
  ];
}

export function LinkInsertMenu({
  siteUrl,
  quickLinks,
  textareaRef,
  value,
  onChange,
  className,
}: {
  siteUrl: string | null;
  quickLinks: LinkInsertQuickLink[];
  /** Target text field to insert at the cursor of; omit to just append. */
  textareaRef?: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  if (!siteUrl) {
    return (
      <p className={`text-xs text-muted-foreground ${className ?? ""}`}>
        <a href="/configuracoes/casa" className="font-medium text-primary hover:underline">
          Cadastre a URL da casa
        </a>{" "}
        para inserir links na mensagem.
      </p>
    );
  }

  const items = linkInsertItems({ siteUrl, quickLinks });

  function insert(token: string) {
    const el = textareaRef?.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const { text, cursor } = insertAtCursor(value, start, end, token);
    onChange(text);
    if (el) {
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(cursor, cursor);
      });
    }
  }

  return (
    <div className={`rounded-md border border-border/60 bg-muted/30 p-2 ${className ?? ""}`}>
      <p className="mb-1.5 text-label text-muted-foreground">
        Inserir link — clique para inserir
      </p>
      <div className="flex flex-wrap gap-1">
        {items.map((item) => (
          <Badge
            key={item.token}
            variant="outline"
            className="cursor-pointer font-mono text-meta hover:bg-primary hover:text-primary-foreground"
            onClick={() => insert(item.token)}
            title={`${item.label} — clique para inserir`}
          >
            {item.token}
          </Badge>
        ))}
      </div>
    </div>
  );
}
