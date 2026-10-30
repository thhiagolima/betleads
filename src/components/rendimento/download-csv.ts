// Download de um CSV gerado no servidor (Blob + link temporário), usado pelo
// extrato, pela carteira e pelo cabeçalho do relatório de rendimento.

/** Baixa `csv` como arquivo com o nome `filename`. */
export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
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
