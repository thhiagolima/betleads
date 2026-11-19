// Entrega de um CSV gerado no servidor, usado pelo extrato, pela carteira, pelo
// cabeçalho do relatório de rendimento e pelo ranking da equipe. No celular
// tenta o menu de compartilhar do sistema (no app instalado no iPhone e nos
// navegadores dentro do WhatsApp/Instagram o download não acontece); se não
// der, cai no download comum (Blob + link temporário).

export type CsvDelivery = "shared" | "downloaded" | "cancelled";

function isTouchDevice(): boolean {
  return (
    typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches ?? false)
  );
}

function triggerDownload(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoga depois de um pequeno atraso: o Firefox pode cancelar o download
  // se a URL do objeto for revogada antes de a leitura do blob começar.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Entrega `csv` como arquivo `filename`: compartilhar no celular, download no resto. */
export async function downloadCsv(filename: string, csv: string): Promise<CsvDelivery> {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  if (isTouchDevice() && typeof File !== "undefined") {
    const file = new File([blob], filename, { type: "text/csv" });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        return "shared";
      } catch (error) {
        // The person closed the share sheet: nothing else to do.
        if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
        // NotAllowedError (the tap "expired" while the server built the file)
        // or anything else: fall back to the plain download.
      }
    }
  }
  triggerDownload(filename, blob);
  return "downloaded";
}

/** Toast text after `downloadCsv`; null when the person cancelled. We can't
 * know whether the browser really saved the file, so it never claims that. */
export function csvDeliveryMessage(delivery: CsvDelivery): string | null {
  return delivery === "cancelled" ? null : "Arquivo gerado.";
}
