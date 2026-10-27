// Reads a phone list file in the browser (CSV, TXT, XLS, XLSX) into plain text
// for `parsePhoneList`. The spreadsheet parser is loaded only when a
// spreadsheet is picked, so it stays out of the main bundle.

export const PHONE_LIST_FILE_ACCEPT =
  ".csv,.txt,.xls,.xlsx,text/csv,text/plain,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export async function readPhoneListFile(file: File): Promise<string> {
  if (file.size > MAX_FILE_BYTES) throw new Error("Arquivo maior que 10 MB.");
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
    // rawNumbers: a phone stored as a number (5511987654321) must not come out
    // as "5,51199E+12" from the cell's display format.
    return workbook.SheetNames.map((sheet) =>
      XLSX.utils.sheet_to_csv(workbook.Sheets[sheet], {
        FS: ";",
        blankrows: false,
        rawNumbers: true,
      }),
    ).join("\n");
  }
  if (name.endsWith(".csv") || name.endsWith(".txt")) return file.text();
  throw new Error("Formato não suportado. Use CSV, TXT, XLS ou XLSX.");
}
