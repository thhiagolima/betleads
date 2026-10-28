// Pure planner that turns the raw tenant sources into a preview of what a
// link-domain change would touch (journeys/templates/quick links/tracking).
// No server imports: this module is client-safe, same as link-domain.ts.

import { countSubdomainLinks, normalizeLinkDomain, replaceLinkDomain } from "./link-domain";
import { countSmsSegments } from "./sms-segments";

export type LinkDomainSources = {
  journeySteps: {
    id: string;
    journeyId: string;
    journeyName: string;
    journeyStatus: string;
    position: number;
    stepType: "sms" | "email";
    label: string | null;
    config: Record<string, unknown>;
  }[];
  smsTemplates: { id: string; name: string; content: string }[];
  emailTemplates: {
    id: string;
    name: string;
    subject: string;
    preheader: string | null;
    body_html: string;
    body_text: string;
  }[];
  quickLinks: { id: string; label: string; path: string }[];
  trackingHosts: string[] | null; // null = casa sem shortio_settings
  scheduledCampaigns: { id: string; name: string; channel: "sms" | "email"; text: string }[];
  activeLegacyFlows: { id: string; name: string; text: string }[]; // text = conteúdos concatenados
};

export type LinkDomainItemKind = "journey_step" | "sms_template" | "email_template" | "quick_link";

export type LinkDomainItem = {
  key: string; // `${kind}:${id}` — usado na seleção
  kind: LinkDomainItemKind;
  id: string;
  title: string; // nome da jornada / template / link rápido
  detail: string | null; // ex.: "Etapa 3 · SMS"
  replacements: number;
  sample: { before: string; after: string }; // primeira ocorrência, ~80 chars em volta
  blockedReason: string | null;
  segmentWarning: { before: number; after: number } | null;
  update: Record<string, unknown>; // novos valores: {config} | {content} | {subject,preheader,body_html,body_text} | {path}
  previous: Record<string, unknown>; // mesmos campos de `update`, valores atuais (vai para o audit log)
};

export type LinkDomainPreview = {
  from: string;
  to: string;
  items: LinkDomainItem[];
  trackingHosts: { current: string[]; next: string[] } | null; // null = nada a fazer
  outOfScope: {
    scheduledCampaigns: { id: string; name: string; channel: "sms" | "email" }[];
    legacyFlows: { id: string; name: string }[];
    subdomainLinks: number;
  };
};

const SMS_TEMPLATE_LIMIT = 480;
const JOURNEY_SMS_LIMIT = 1600;
const SUBJECT_LIMIT = 255;
const QUICK_LINK_LIMIT = 500;

const SAMPLE_WINDOW = 40;

function limitMessage(limit: number): string {
  return `O texto passaria de ${limit} caracteres.`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// Mirrors the host-matching logic in replaceLinkDomain/countSubdomainLinks,
// but only to locate the first match's position for the sample window — kept
// local to this module since link-domain.ts doesn't export that detail.
const SAMPLE_URL_RE = /\bhttps?:\/\/([^\s/?#"'<>()]+)/gi;

function firstMatchRange(text: string, from: string): { start: number; end: number } | null {
  for (const match of text.matchAll(SAMPLE_URL_RE)) {
    const hostPort = match[1];
    let end = hostPort.length;
    while (end > 0 && !/[a-zA-Z0-9]/.test(hostPort[end - 1])) {
      end -= 1;
    }
    const core = hostPort.slice(0, end);
    const colonIndex = core.lastIndexOf(":");
    let host = core;
    if (colonIndex !== -1 && /^\d+$/.test(core.slice(colonIndex + 1))) {
      host = core.slice(0, colonIndex);
    }
    const lowerHost = host.toLowerCase();
    const bareHost = lowerHost.startsWith("www.") ? lowerHost.slice(4) : lowerHost;
    if (bareHost === from) {
      const start = match.index ?? 0;
      return { start, end: start + match[0].length };
    }
  }
  return null;
}

/** Builds a ~80-char window around the first replaced occurrence, showing
 * the text before and after the swap. The window always starts before the
 * first match, so it contains that match's whole host — `after` is derived
 * by re-running the swap on just the `before` window (rather than slicing
 * the fully-replaced string with a whole-field length delta, which would be
 * thrown off by any other occurrences elsewhere in the same field). Returns
 * null when `from` isn't found in `original` (nothing to sample). */
function sampleWindow(original: string, from: string, to: string): { before: string; after: string } | null {
  const range = firstMatchRange(original, from);
  if (!range) {
    return null;
  }
  const windowStart = Math.max(0, range.start - SAMPLE_WINDOW);
  const windowEnd = Math.min(original.length, range.end + SAMPLE_WINDOW);
  const before = original.slice(windowStart, windowEnd);
  const after = replaceLinkDomain(before, from, to).text;
  return { before, after };
}

function firstSample(
  candidates: { before: string; after: string }[],
  original: string,
  from: string,
  to: string,
): void {
  const sample = sampleWindow(original, from, to);
  if (sample) {
    candidates.push(sample);
  }
}

/** Text fields that carry hand-written links for a given journey step,
 * in the order they should be swapped/sampled. */
function journeyStepTexts(config: Record<string, unknown>, stepType: "sms" | "email"): string[] {
  const texts: string[] = [];
  if (stepType === "sms") {
    if (typeof config.content === "string") {
      texts.push(config.content);
    }
    if (Array.isArray(config.variants)) {
      for (const variant of config.variants) {
        if (typeof variant === "string") {
          texts.push(variant);
        }
      }
    }
    const snapshot = config.template_snapshot as Record<string, unknown> | undefined;
    if (snapshot && typeof snapshot.content === "string") {
      texts.push(snapshot.content);
    }
  } else {
    const snapshot = config.template_snapshot as Record<string, unknown> | undefined;
    if (snapshot) {
      for (const field of ["subject", "preheader", "body_html", "body_text"]) {
        const value = snapshot[field];
        if (typeof value === "string") {
          texts.push(value);
        }
      }
    }
  }
  return texts;
}

type ConfigSwapResult = {
  config: Record<string, unknown>;
  replacements: number;
  sample: { before: string; after: string } | null;
  blockedReason: string | null;
  smsTexts: { before: string[]; after: string[] } | null;
};

function swapJourneyStepConfig(
  config: Record<string, unknown>,
  stepType: "sms" | "email",
  from: string,
  to: string,
): ConfigSwapResult {
  const newConfig = cloneJson(config);
  let replacements = 0;
  let blockedReason: string | null = null;
  const samples: { before: string; after: string }[] = [];
  const smsBefore: string[] = [];
  const smsAfter: string[] = [];

  function consider(original: string, limit: number | null, limitMessageText: string | null, isSms: boolean): string {
    const { text: replaced, count } = replaceLinkDomain(original, from, to);
    if (count > 0) {
      replacements += count;
      firstSample(samples, original, from, to);
    }
    if (limit !== null && replaced.length > limit && blockedReason === null) {
      blockedReason = limitMessageText ?? limitMessage(limit);
    }
    if (isSms) {
      smsBefore.push(original);
      smsAfter.push(replaced);
    }
    return replaced;
  }

  if (stepType === "sms") {
    if (typeof config.content === "string") {
      newConfig.content = consider(config.content, JOURNEY_SMS_LIMIT, null, true);
    }
    if (Array.isArray(config.variants)) {
      newConfig.variants = config.variants.map((variant) => {
        if (typeof variant !== "string") {
          return variant;
        }
        return consider(variant, JOURNEY_SMS_LIMIT, null, true);
      });
    }
    const originalSnapshot = config.template_snapshot as Record<string, unknown> | undefined;
    const newSnapshot = newConfig.template_snapshot as Record<string, unknown> | undefined;
    if (originalSnapshot && newSnapshot && typeof originalSnapshot.content === "string") {
      newSnapshot.content = consider(originalSnapshot.content, JOURNEY_SMS_LIMIT, null, false);
    }
  } else {
    const originalSnapshot = config.template_snapshot as Record<string, unknown> | undefined;
    const newSnapshot = newConfig.template_snapshot as Record<string, unknown> | undefined;
    if (originalSnapshot && newSnapshot) {
      if (typeof originalSnapshot.subject === "string") {
        newSnapshot.subject = consider(
          originalSnapshot.subject,
          SUBJECT_LIMIT,
          "O assunto passaria de 255 caracteres.",
          false,
        );
      }
      if (typeof originalSnapshot.preheader === "string") {
        newSnapshot.preheader = consider(originalSnapshot.preheader, null, null, false);
      }
      if (typeof originalSnapshot.body_html === "string") {
        newSnapshot.body_html = consider(originalSnapshot.body_html, null, null, false);
      }
      if (typeof originalSnapshot.body_text === "string") {
        newSnapshot.body_text = consider(originalSnapshot.body_text, null, null, false);
      }
    }
  }

  return {
    config: newConfig,
    replacements,
    sample: samples[0] ?? null,
    blockedReason,
    smsTexts: stepType === "sms" ? { before: smsBefore, after: smsAfter } : null,
  };
}

function maxSegments(texts: string[]): number {
  return texts.reduce((max, text) => Math.max(max, countSmsSegments(text).segments), 0);
}

function computeTrackingHosts(
  trackingHosts: string[] | null,
  to: string,
): { current: string[]; next: string[] } | null {
  if (trackingHosts === null || trackingHosts.length === 0) {
    return null;
  }
  if (trackingHosts.includes(to)) {
    return null;
  }
  return { current: [...trackingHosts], next: [...trackingHosts, to] };
}

export function planLinkDomainChange(
  sources: LinkDomainSources,
  fromInput: string,
  toInput: string,
): { ok: true; preview: LinkDomainPreview } | { ok: false; error: string } {
  const fromResult = normalizeLinkDomain(fromInput);
  if (!fromResult.ok) {
    return { ok: false, error: fromResult.error };
  }
  const toResult = normalizeLinkDomain(toInput);
  if (!toResult.ok) {
    return { ok: false, error: toResult.error };
  }
  const from = fromResult.domain;
  const to = toResult.domain;
  if (from === to) {
    return { ok: false, error: "Os dois domínios são iguais." };
  }

  type JourneyAux = { journeyName: string; position: number; item: LinkDomainItem };
  const journeyAux: JourneyAux[] = [];
  for (const step of sources.journeySteps) {
    const swap = swapJourneyStepConfig(step.config, step.stepType, from, to);
    if (swap.replacements === 0) {
      continue;
    }

    let segmentWarning: { before: number; after: number } | null = null;
    if (swap.smsTexts && step.config.track_links === false) {
      const before = maxSegments(swap.smsTexts.before);
      const after = maxSegments(swap.smsTexts.after);
      if (after > before) {
        segmentWarning = { before, after };
      }
    }

    journeyAux.push({
      journeyName: step.journeyName,
      position: step.position,
      item: {
        key: `journey_step:${step.id}`,
        kind: "journey_step",
        id: step.id,
        title: step.journeyName,
        detail: `Etapa ${step.position + 1} · ${step.stepType === "sms" ? "SMS" : "E-mail"}`,
        replacements: swap.replacements,
        sample: swap.sample ?? { before: "", after: "" },
        blockedReason: swap.blockedReason,
        segmentWarning,
        update: { config: swap.config },
        previous: { config: cloneJson(step.config) },
      },
    });
  }
  journeyAux.sort((a, b) => a.journeyName.localeCompare(b.journeyName) || a.position - b.position);
  const journeyItems = journeyAux.map((aux) => aux.item);

  const smsItems: LinkDomainItem[] = [];
  for (const template of sources.smsTemplates) {
    const { text: newContent, count } = replaceLinkDomain(template.content, from, to);
    if (count === 0) {
      continue;
    }
    smsItems.push({
      key: `sms_template:${template.id}`,
      kind: "sms_template",
      id: template.id,
      title: template.name,
      detail: null,
      replacements: count,
      sample: sampleWindow(template.content, from, to) ?? { before: "", after: "" },
      blockedReason: newContent.length > SMS_TEMPLATE_LIMIT ? limitMessage(SMS_TEMPLATE_LIMIT) : null,
      segmentWarning: null,
      update: { content: newContent },
      previous: { content: template.content },
    });
  }

  const emailItems: LinkDomainItem[] = [];
  for (const template of sources.emailTemplates) {
    const subjectR = replaceLinkDomain(template.subject, from, to);
    const preheaderR = replaceLinkDomain(template.preheader ?? "", from, to);
    const bodyHtmlR = replaceLinkDomain(template.body_html, from, to);
    const bodyTextR = replaceLinkDomain(template.body_text, from, to);
    const totalReplacements = subjectR.count + preheaderR.count + bodyHtmlR.count + bodyTextR.count;
    if (totalReplacements === 0) {
      continue;
    }
    const sample =
      sampleWindow(template.subject, from, to) ??
      (template.preheader !== null ? sampleWindow(template.preheader, from, to) : null) ??
      sampleWindow(template.body_html, from, to) ??
      sampleWindow(template.body_text, from, to) ?? { before: "", after: "" };
    emailItems.push({
      key: `email_template:${template.id}`,
      kind: "email_template",
      id: template.id,
      title: template.name,
      detail: null,
      replacements: totalReplacements,
      sample,
      blockedReason: null,
      segmentWarning: null,
      update: {
        subject: subjectR.text,
        preheader: template.preheader === null ? null : preheaderR.text,
        body_html: bodyHtmlR.text,
        body_text: bodyTextR.text,
      },
      previous: {
        subject: template.subject,
        preheader: template.preheader,
        body_html: template.body_html,
        body_text: template.body_text,
      },
    });
  }

  const quickLinkItems: LinkDomainItem[] = [];
  for (const quickLink of sources.quickLinks) {
    const { text: newPath, count } = replaceLinkDomain(quickLink.path, from, to);
    if (count === 0) {
      continue;
    }
    quickLinkItems.push({
      key: `quick_link:${quickLink.id}`,
      kind: "quick_link",
      id: quickLink.id,
      title: quickLink.label,
      detail: null,
      replacements: count,
      sample: sampleWindow(quickLink.path, from, to) ?? { before: "", after: "" },
      blockedReason: newPath.length > QUICK_LINK_LIMIT ? "O link passaria de 500 caracteres." : null,
      segmentWarning: null,
      update: { path: newPath },
      previous: { path: quickLink.path },
    });
  }

  const items = [...journeyItems, ...smsItems, ...emailItems, ...quickLinkItems];

  const trackingHosts = computeTrackingHosts(sources.trackingHosts, to);

  const scheduledCampaigns = sources.scheduledCampaigns
    .filter((campaign) => replaceLinkDomain(campaign.text, from, to).count > 0)
    .map((campaign) => ({ id: campaign.id, name: campaign.name, channel: campaign.channel }));
  const legacyFlows = sources.activeLegacyFlows
    .filter((flow) => replaceLinkDomain(flow.text, from, to).count > 0)
    .map((flow) => ({ id: flow.id, name: flow.name }));

  let subdomainLinks = 0;
  for (const step of sources.journeySteps) {
    for (const text of journeyStepTexts(step.config, step.stepType)) {
      subdomainLinks += countSubdomainLinks(text, from);
    }
  }
  for (const template of sources.smsTemplates) {
    subdomainLinks += countSubdomainLinks(template.content, from);
  }
  for (const template of sources.emailTemplates) {
    subdomainLinks += countSubdomainLinks(template.subject, from);
    if (template.preheader !== null) {
      subdomainLinks += countSubdomainLinks(template.preheader, from);
    }
    subdomainLinks += countSubdomainLinks(template.body_html, from);
    subdomainLinks += countSubdomainLinks(template.body_text, from);
  }
  for (const quickLink of sources.quickLinks) {
    subdomainLinks += countSubdomainLinks(quickLink.path, from);
  }

  return {
    ok: true,
    preview: {
      from,
      to,
      items,
      trackingHosts,
      outOfScope: { scheduledCampaigns, legacyFlows, subdomainLinks },
    },
  };
}

export function hasLinkDomainWork(preview: LinkDomainPreview): boolean {
  return preview.items.length > 0 || preview.trackingHosts !== null;
}
