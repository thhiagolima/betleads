import { HistoryShell } from "@/components/history/history-shell";

export function SmsHistoryPanel() {
  return (
    <HistoryShell
      channel="sms"
      options={{
        title: "Histórico de SMS",
        subtitle: "Todos os disparos, respostas e falhas do canal.",
      }}
    />
  );
}
