import type { TriggerType } from "@/lib/triggers";

export type AutomationJourneyDraft = {
  channel: "sms" | "email";
  name: string;
  trigger: TriggerType;
  createdAt: number;
};

const STORAGE_KEY = "betleads:automation-journey-draft";
const MAX_AGE_MS = 15 * 60 * 1000;

export function saveAutomationJourneyDraft(draft: AutomationJourneyDraft) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
}

export function consumeAutomationJourneyDraft(channel: AutomationJourneyDraft["channel"]) {
  if (typeof window === "undefined") return null;

  const raw = window.sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  window.sessionStorage.removeItem(STORAGE_KEY);

  try {
    const parsed = JSON.parse(raw) as Partial<AutomationJourneyDraft>;
    if (
      parsed.channel !== channel ||
      typeof parsed.name !== "string" ||
      !parsed.name.trim() ||
      typeof parsed.trigger !== "string" ||
      typeof parsed.createdAt !== "number" ||
      Date.now() - parsed.createdAt > MAX_AGE_MS
    ) {
      return null;
    }

    return {
      channel,
      name: parsed.name.trim(),
      trigger: parsed.trigger as TriggerType,
      createdAt: parsed.createdAt,
    } satisfies AutomationJourneyDraft;
  } catch {
    return null;
  }
}
