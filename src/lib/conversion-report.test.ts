import { describe, expect, it } from "vitest";
import {
  buildJourneyStepConversions,
  canAccessConversionDrilldown,
  journeyStepPositionRanges,
  deliveryIdentity,
  uniqueDeliveryCount,
} from "./conversion-report";

describe("conversion report delivery semantics", () => {
  it("counts one delivery when the message contains multiple links", () => {
    const rows = [
      { id: "a", idempotency_key: "send-1:0", send_status: "sent" },
      { id: "b", idempotency_key: "send-1:1", send_status: "sent" },
      { id: "c", idempotency_key: "send-2:0", send_status: "sent" },
    ];
    expect(uniqueDeliveryCount(rows, (row) => row.send_status === "sent")).toBe(2);
    expect(deliveryIdentity(rows[0])).toBe("delivery:send-1");
  });

  it("uses the message log identity when available", () => {
    expect(
      uniqueDeliveryCount(
        [
          { id: "a", message_log_id: "log-1", send_status: "sent" },
          { id: "b", message_log_id: "log-1", send_status: "sent" },
        ],
        () => true,
      ),
    ).toBe(1);
  });
});

describe("conversion report permissions", () => {
  it("allows only tenant admin or super admin", () => {
    expect(canAccessConversionDrilldown("admin", false)).toBe(true);
    expect(canAccessConversionDrilldown("super_admin", false)).toBe(true);
    expect(canAccessConversionDrilldown("gestor", false)).toBe(false);
    expect(canAccessConversionDrilldown("member", false)).toBe(false);
    expect(canAccessConversionDrilldown(null, true)).toBe(true);
  });
});

describe("journey step conversions", () => {
  // Fixture mirrors "Dormindo — 7 dias sem depósito": sms@0, wait@1, sms@2,
  // wait@3, sms@4, end@5. A R$ 35,00 direct deposit and logins point to
  // dispatches of step 0 and step 2.
  const steps = [
    { id: "s0", position: 0, step_type: "sms" },
    { id: "w1", position: 1, step_type: "wait" },
    { id: "s2", position: 2, step_type: "sms" },
    { id: "w3", position: 3, step_type: "wait" },
    { id: "s4", position: 4, step_type: "sms" },
    { id: "e5", position: 5, step_type: "end" },
  ];
  const dispatches = [
    {
      id: "d1",
      idempotency_key: "k1:0",
      send_status: "sent",
      channel: "sms",
      journey_step_id: "s0",
      journey_step_position: 0,
      tracking_token: "t1",
    },
    {
      id: "d2",
      idempotency_key: "k2:0",
      send_status: "sent",
      channel: "sms",
      journey_step_id: "s0",
      journey_step_position: 0,
      tracking_token: "t2",
    },
    // Step recreated by an edit: stale id, position still valid.
    {
      id: "d3",
      idempotency_key: "k3:0",
      send_status: "sent",
      channel: "sms",
      journey_step_id: "old-s2",
      journey_step_position: 2,
      tracking_token: "t3",
    },
  ];
  const attributions = [
    {
      link_dispatch_id: "d2",
      event_type: "deposit_approved",
      classification: "direct",
      monetary_value: "35.00",
    },
    { link_dispatch_id: "d1", event_type: "login", classification: "direct", monetary_value: null },
    { link_dispatch_id: "d3", event_type: "login", classification: "direct", monetary_value: null },
    {
      link_dispatch_id: "d3",
      event_type: "deposit_approved",
      classification: "assisted",
      monetary_value: "99",
    },
  ];

  it("lands the attributed deposit on its step (id, then position)", () => {
    const result = buildJourneyStepConversions({
      steps,
      dispatches,
      attributions,
      confirmedDispatchIds: new Set(["d2", "d3"]),
    });
    expect(result.steps.map((step) => step.stepId)).toEqual(["s0", "s2", "s4"]);
    const [s0, s2, s4] = result.steps;
    expect(s0).toMatchObject({ sent: 2, clicked: 1, deposits: 1, recovered: 35 });
    expect(s2).toMatchObject({ sent: 1, clicked: 1, deposits: 0, recovered: 0 });
    expect(s4).toMatchObject({ sent: 0, deposits: 0 });
    expect(result.unassigned).toEqual({ deposits: 0, recovered: 0 });
  });

  it("does not depend on the dispatch list order or size", () => {
    const many = Array.from({ length: 1600 }, (_, index) => ({
      id: `x${index}`,
      idempotency_key: `x${index}:0`,
      send_status: "sent",
      journey_step_id: "s0",
      journey_step_position: 0,
    }));
    const result = buildJourneyStepConversions({
      steps,
      dispatches: [...many, ...dispatches],
      attributions,
      confirmedDispatchIds: new Set(),
    });
    expect(result.steps[0]).toMatchObject({ deposits: 1, recovered: 35, sent: 1602 });
  });

  it("reports deposits without a resolvable step instead of dropping them", () => {
    const result = buildJourneyStepConversions({
      steps,
      dispatches: [
        { id: "d9", journey_step_id: null, journey_step_position: null, tracking_token: "t9" },
      ],
      attributions: [
        ...attributions,
        {
          link_dispatch_id: null,
          tracking_token: "t9",
          event_type: "deposit_approved",
          classification: "direct",
          monetary_value: 10,
        },
        {
          link_dispatch_id: "missing",
          event_type: "deposit_approved",
          classification: "direct",
          monetary_value: 5,
        },
      ],
      confirmedDispatchIds: new Set(),
    });
    expect(result.unassigned).toEqual({ deposits: 3, recovered: 50 });
    const stepTotal = result.steps.reduce((sum, step) => sum + step.deposits, 0);
    expect(stepTotal + result.unassigned.deposits).toBe(3);
  });
});

describe("journey step position ranges", () => {
  it("assigns waits to the next communication step", () => {
    expect(
      journeyStepPositionRanges([
        { id: "s0", position: 0, step_type: "sms" },
        { id: "w1", position: 1, step_type: "wait" },
        { id: "s2", position: 2, step_type: "sms" },
        { id: "e3", position: 3, step_type: "end" },
      ]),
    ).toEqual([
      { stepId: "s0", from: 0, to: 0 },
      { stepId: "s2", from: 1, to: 2 },
    ]);
  });
});

describe("disabled journey steps", () => {
  it("are excluded from step conversions and position ranges", () => {
    const steps = [
      { id: "s0", position: 0, step_type: "sms" },
      { id: "s1", position: 1, step_type: "sms", is_enabled: false },
      { id: "w2", position: 2, step_type: "wait" },
      { id: "s3", position: 3, step_type: "sms" },
    ];
    expect(journeyStepPositionRanges(steps)).toEqual([
      { stepId: "s0", from: 0, to: 0 },
      { stepId: "s3", from: 1, to: 3 },
    ]);
    const result = buildJourneyStepConversions({
      steps,
      dispatches: [
        { id: "d1", journey_step_id: "s1", journey_step_position: 1, send_status: "sent" },
      ],
      attributions: [
        {
          link_dispatch_id: "d1",
          event_type: "deposit_approved",
          classification: "direct",
          monetary_value: 7,
        },
      ],
      confirmedDispatchIds: new Set(),
    });
    expect(result.steps.map((step) => step.stepId)).toEqual(["s0", "s3"]);
    // A disabled step keeps its history instead of becoming "unassigned".
    expect(result.retired).toHaveLength(1);
    expect(result.retired[0]).toMatchObject({ stepId: "s1", sent: 1, deposits: 1, recovered: 7 });
    expect(result.unassigned).toEqual({ deposits: 0, recovered: 0 });
  });

  it("hides disabled steps that never sent nor converted", () => {
    const result = buildJourneyStepConversions({
      steps: [
        { id: "s0", position: 0, step_type: "sms" },
        { id: "s1", position: 1, step_type: "sms", is_enabled: false },
      ],
      dispatches: [],
      attributions: [],
      confirmedDispatchIds: new Set(),
    });
    expect(result.retired).toEqual([]);
  });

  it("does not move a disabled step's sends to the enabled step at its position", () => {
    const result = buildJourneyStepConversions({
      steps: [
        { id: "old", position: 0, step_type: "sms", is_enabled: false },
        { id: "new", position: 0, step_type: "sms" },
      ],
      dispatches: [
        { id: "d1", journey_step_id: "old", journey_step_position: 0, send_status: "sent" },
        { id: "d2", journey_step_id: "gone", journey_step_position: 0, send_status: "sent" },
      ],
      attributions: [],
      confirmedDispatchIds: new Set(),
    });
    expect(result.steps[0]).toMatchObject({ stepId: "new", sent: 1 });
    expect(result.retired[0]).toMatchObject({ stepId: "old", sent: 1 });
  });
});

describe("journey copy rotation", () => {
  // "Saque pago": a single SMS step drawing one of its copies per withdrawal.
  const steps = [{ id: "s0", position: 0, step_type: "sms" }];
  const dispatches = [
    { id: "d1", idempotency_key: "e1:0", send_status: "sent", journey_step_id: "s0" },
    { id: "d1b", idempotency_key: "e1:1", send_status: "sent", journey_step_id: "s0" },
    { id: "d2", idempotency_key: "e2:0", send_status: "sent", journey_step_id: "s0" },
    { id: "d3", idempotency_key: "e3:0", send_status: "sent", journey_step_id: "s0" },
    // Sent before the step rotated copies: no copy recorded.
    { id: "d4", idempotency_key: "e4:0", send_status: "sent", journey_step_id: "s0" },
  ];
  const variantByDelivery = new Map([
    ["e1", 0],
    ["e2", 2],
    ["e3", 2],
  ]);
  const deposit = (id: string, value: number) => ({
    link_dispatch_id: id,
    event_type: "deposit_approved",
    classification: "direct",
    monetary_value: value,
  });

  it("splits sends, clicks and deposits per copy", () => {
    const result = buildJourneyStepConversions({
      steps,
      dispatches,
      attributions: [deposit("d1b", 20), deposit("d2", 50), deposit("d3", 30), deposit("d4", 5)],
      confirmedDispatchIds: new Set(["d2"]),
      variantByDelivery,
    });
    const [step] = result.steps;
    expect(step).toMatchObject({ sent: 4, clicked: 1, deposits: 4, recovered: 105 });
    expect(step.variants).toEqual([
      { variant: 0, sent: 1, delivered: 0, clicked: 0, deposits: 1, recovered: 20 },
      { variant: 2, sent: 2, delivered: 0, clicked: 1, deposits: 2, recovered: 80 },
    ]);
    expect(step.withoutVariant).toMatchObject({ sent: 1, deposits: 1, recovered: 5 });
  });

  it("has no copy split when no copy was recorded", () => {
    const result = buildJourneyStepConversions({
      steps,
      dispatches,
      attributions: [],
      confirmedDispatchIds: new Set(),
    });
    expect(result.steps[0].variants).toEqual([]);
    expect(result.steps[0].withoutVariant.sent).toBe(4);
  });
});
