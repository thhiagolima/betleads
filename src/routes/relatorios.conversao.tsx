import { createFileRoute } from "@tanstack/react-router";
import { ExecutiveConversionReport } from "@/components/executive-conversion-report";

export const Route = createFileRoute("/relatorios/conversao")({
  component: ExecutiveConversionReport,
});
