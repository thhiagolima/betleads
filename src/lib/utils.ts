import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** Type-scale tokens defined in styles.css (`--text-*`). */
export const TEXT_SIZE_TOKENS = ["title", "section", "body", "label", "meta", "kpi", "kpi-sm"];

// Without this, tailwind-merge reads `text-kpi` as a colour and drops it when a
// colour class follows (`text-kpi text-success` → `text-success`).
const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: TEXT_SIZE_TOKENS }] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
