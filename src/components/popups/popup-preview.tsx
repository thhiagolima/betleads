import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import type { PopupFormat } from "@/lib/popups/shared";

export type PopupPreviewContent = {
  formato: PopupFormat;
  imageUrl: string | null;
  titulo: string | null;
  texto: string | null;
  botaoLabel: string | null;
};

/**
 * Prévia do popup como o site mostra (popups/popup-runtime.ts): mesmo cartão
 * branco, mesmo botão escuro, mesmos três formatos. A moldura imita a tela
 * da casa, no computador ou no celular.
 */
export function PopupPreview({ content, device }: { content: PopupPreviewContent; device: "desktop" | "mobile" }) {
  const { formato, imageUrl, titulo, texto, botaoLabel } = content;
  const empty = !titulo && !imageUrl;
  const body = (
    <>
      {titulo ? <h2 className="mb-1.5 text-[17px] font-bold leading-snug text-[#111827]">{titulo}</h2> : null}
      {texto ? <p className="whitespace-pre-line text-[13px] leading-relaxed text-[#374151]">{texto}</p> : null}
    </>
  );
  const button = botaoLabel ? (
    <span
      className={cn(
        "block rounded-[10px] bg-[#111827] px-4 py-2.5 text-center text-[14px] font-semibold text-white",
        formato === "rodape" ? "shrink-0" : "mt-3 w-full",
      )}
    >
      {botaoLabel}
    </span>
  ) : null;
  const close = (
    <span className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-[#111827]/65 text-white">
      <X className="h-4 w-4" aria-hidden />
    </span>
  );

  return (
    <div
      className={cn(
        "relative mx-auto overflow-hidden rounded-xl border border-border/60 bg-gradient-to-b from-zinc-800 to-zinc-900",
        device === "desktop" ? "aspect-[16/10] w-full" : "aspect-[9/17] w-[240px]",
      )}
      aria-label={`Prévia no ${device === "desktop" ? "computador" : "celular"}`}
      role="img"
    >
      <div className="absolute inset-x-0 top-0 flex h-7 items-center gap-1.5 border-b border-white/5 bg-zinc-900/80 px-3">
        <span className="h-2 w-2 rounded-full bg-white/20" />
        <span className="h-2 w-2 rounded-full bg-white/20" />
        <span className="h-2 w-2 rounded-full bg-white/20" />
        <span className="ml-2 h-3 flex-1 rounded bg-white/5" />
      </div>
      {empty ? (
        <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-white/50">
          Coloque um título ou uma imagem para ver a prévia.
        </p>
      ) : formato === "central" ? (
        <div className="absolute inset-0 top-7 flex items-center justify-center bg-black/60 p-3">
          <div className="relative max-h-full w-full max-w-[300px] overflow-y-auto rounded-[14px] bg-white shadow-2xl">
            {imageUrl ? <img src={imageUrl} alt="" className="block h-auto w-full" /> : null}
            {titulo || texto || button ? (
              <div className="p-3.5">
                {body}
                {button}
              </div>
            ) : null}
            {close}
          </div>
        </div>
      ) : formato === "canto" ? (
        <div
          className={cn(
            "absolute bottom-3 right-3 overflow-hidden rounded-[14px] bg-white shadow-2xl",
            device === "desktop" ? "w-[220px]" : "left-3 w-auto",
          )}
        >
          {imageUrl ? <img src={imageUrl} alt="" className="block h-auto w-full" /> : null}
          {titulo || texto || button ? (
            <div className="p-3">
              {body}
              {button}
            </div>
          ) : null}
          {close}
        </div>
      ) : (
        <div
          className={cn(
            "absolute inset-x-0 bottom-0 flex items-center gap-3 rounded-t-[14px] bg-white p-3 pr-11 shadow-2xl",
            device === "mobile" && "flex-wrap",
          )}
        >
          {imageUrl ? <img src={imageUrl} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" /> : null}
          <div className="min-w-0 flex-1">{body}</div>
          {button ? <div className={cn(device === "mobile" && "w-full")}>{button}</div> : null}
          {close}
        </div>
      )}
    </div>
  );
}
