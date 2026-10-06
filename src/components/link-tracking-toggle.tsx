import { Link2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  LINK_TRACKING_PREVIEW_URL,
  messageUrls,
  previewTrackedText,
  smsPartsForLength,
} from "@/lib/link-tracking-preview";

type LinkTrackingToggleProps = {
  value: boolean;
  onChange: (value: boolean) => void;
  content: string;
  channel: "sms" | "email";
  className?: string;
};

export function LinkTrackingToggle({
  value,
  onChange,
  content,
  channel,
  className,
}: LinkTrackingToggleProps) {
  const urls = messageUrls(content);
  const preview = previewTrackedText(content, value);
  const originalLength = content.length;
  const previewLength = preview.length;
  const originalParts = smsPartsForLength(originalLength);
  const previewParts = smsPartsForLength(previewLength);

  return (
    <div className={className ?? "rounded-xl border border-primary/25 bg-primary/5 p-3"}>
      <div className="flex items-start gap-3">
        <Checkbox
          id={`track-links-${channel}`}
          checked={value}
          onCheckedChange={(checked) => onChange(checked === true)}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1 space-y-1">
          <Label
            htmlFor={`track-links-${channel}`}
            className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-primary"
          >
            <Link2 className="h-4 w-4" /> Encurtar e medir os links
          </Label>
          <p className="text-xs leading-5 text-muted-foreground">
            {!urls.length
              ? "Adicione uma URL à mensagem para que o encurtamento e a medição sejam aplicados no envio."
              : value
              ? `Cada URL será substituída por um link como ${LINK_TRACKING_PREVIEW_URL} no envio.`
              : "As URLs originais serão preservadas e nenhum rastreamento será criado."}
          </p>
          {channel === "sms" && (
            <p className="text-xs text-muted-foreground">
              {value ? previewLength : originalLength} caracteres · {value ? previewParts : originalParts}{" "}
              parte{(value ? previewParts : originalParts) === 1 ? "" : "s"}
              {value && (previewLength !== originalLength || previewParts !== originalParts) && (
                <> (original: {originalLength} caracteres · {originalParts} partes)</>
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
