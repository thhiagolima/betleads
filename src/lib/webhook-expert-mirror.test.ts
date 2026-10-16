// F0-04 — CRM Expert mirroring copies webhook events (players, deposits,
// enrollments) into an expert tenant. Every house has its own webhook token
// and controls the payload, so only the expert's source house may feed it;
// otherwise any house could inject leads into an expert tenant by sending
// that expert's affiliate id.

import { describe, expect, it } from "vitest";
import { expertMirrorTargets } from "./webhook-process.server";

const MAIN = "00000000-0000-0000-0000-000000000001";
const OTHER = "00000000-0000-4000-8000-00000000000b";
const EXPERT = "00000000-0000-4000-8000-0000000000e1";
const EXPERT2 = "00000000-0000-4000-8000-0000000000e2";

const experts = [
  { id: EXPERT, metadata: { expert_affiliate_ids: ["aff-1", " aff-2 "] } },
  { id: EXPERT2, metadata: { expert_affiliate_ids: ["aff-9"], source_tenant_id: OTHER } },
];

describe("expertMirrorTargets", () => {
  it("mirrors an event from the expert's source house (main by default)", () => {
    expect(expertMirrorTargets(experts, MAIN, "aff-2")).toEqual([EXPERT]);
  });

  it("does not mirror the same affiliate id sent by another house", () => {
    expect(expertMirrorTargets(experts, OTHER, "aff-1")).toEqual([]);
  });

  it("honours an explicit source_tenant_id", () => {
    expect(expertMirrorTargets(experts, OTHER, "aff-9")).toEqual([EXPERT2]);
    expect(expertMirrorTargets(experts, MAIN, "aff-9")).toEqual([]);
  });

  it("never mirrors into the source itself or without an affiliate id", () => {
    expect(expertMirrorTargets(experts, EXPERT, "aff-1")).toEqual([]);
    expect(expertMirrorTargets(experts, MAIN, null)).toEqual([]);
  });
});
