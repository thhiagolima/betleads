import { HistoryShell } from "@/components/history/history-shell";

export function SmsHistoryPanel() {
  return (
    <HistoryShell
      channel="sms"
      options={{ subtitle: "Todos os envios, respostas e falhas do canal." }}
    />
  );
}
