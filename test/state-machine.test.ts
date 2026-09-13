import { describe, expect, it } from "vitest";
import { InvalidTransitionError } from "../src/domain/errors.js";
import {
  STATE_MACHINE,
  actorClassOf,
  allowedTargets,
  checkTransition,
  type TransitionRequest,
} from "../src/domain/state-machine.js";

describe("actorClassOf", () => {
  const cases = [
    { actor: "auto:gate", expected: "auto" },
    { actor: "auto:canary", expected: "auto" },
    { actor: "human", expected: "human" },
  ] as const;

  for (const { actor, expected } of cases) {
    it(`actorClassOf('${actor}') = '${expected}'`, () => {
      expect(actorClassOf(actor)).toBe(expected);
    });
  }
});

describe("checkTransition: разрешённые рёбра", () => {
  // Каждое ребро STATE_MACHINE проходит с корректным kind и actor'ом своего класса.
  for (const [from, edges] of Object.entries(STATE_MACHINE)) {
    for (const edge of edges) {
      const actor = edge.actors[0] === "human" ? "human" : `auto:${edge.kind}`;
      const req: TransitionRequest = { from: from as TransitionRequest["from"], to: edge.to, kind: edge.kind, actor };
      it(`разрешён: ${req.from} → ${req.to} (kind=${req.kind}, actor=${req.actor})`, () => {
        expect(checkTransition(req).to).toBe(req.to);
      });
    }
  }
});

describe("checkTransition: запрещённые переходы (ТЗ §9)", () => {
  const forbidden: readonly TransitionRequest[] = [
    { from: "candidate", to: "active", kind: "promote", actor: "auto:gate" }, // нельзя пропустить гейты/канарку
    { from: "candidate", to: "deprecated", kind: "demote", actor: "auto:degradation" },
    { from: "queued", to: "active", kind: "promote", actor: "human" }, // из очереди — только в canary
    { from: "canary", to: "queued", kind: "demote", actor: "auto:canary" }, // fail — в candidate с флагом
    { from: "active", to: "archived", kind: "archive", actor: "human" }, // archived — только через deprecated
    { from: "active", to: "canary", kind: "demote", actor: "auto:degradation" },
    { from: "deprecated", to: "candidate", kind: "demote", actor: "human" },
    { from: "archived", to: "active", kind: "promote", actor: "human" }, // терминальное (ТЗ §7.2.1)
  ];

  for (const req of forbidden) {
    it(`запрещён: ${req.from} → ${req.to}`, () => {
      expect(() => checkTransition(req)).toThrowError(InvalidTransitionError);
      expect(() => checkTransition(req)).toThrow(/запрещён|требует|недоступен/);
    });
  }
});

describe("checkTransition: нарушение kind и actor-класса", () => {
  it("kind не совпадает с ребром — ошибка", () => {
    expect(() => checkTransition({ from: "candidate", to: "canary", kind: "demote", actor: "auto:gate" })).toThrowError(
      /требует kind='promote'/,
    );
  });

  it("auto-only ребро не принимает human (candidate → canary)", () => {
    expect(() => checkTransition({ from: "candidate", to: "canary", kind: "promote", actor: "human" })).toThrowError(
      /недоступен actor-классу 'human'/,
    );
  });

  it("human-only ребро не принимает auto (queued → canary)", () => {
    expect(() => checkTransition({ from: "queued", to: "canary", kind: "promote", actor: "auto:gate" })).toThrowError(
      /недоступен actor-классу 'auto'/,
    );
  });
});

describe("allowedTargets", () => {
  it("archived — терминальный статус", () => {
    expect(allowedTargets("archived")).toEqual([]);
  });

  it("deprecated допускает восстановление и архивацию", () => {
    expect(allowedTargets("deprecated").sort()).toEqual(["active", "archived"]);
  });
});
