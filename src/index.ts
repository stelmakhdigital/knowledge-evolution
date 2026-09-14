/**
 * Публичный API `evolve` (единый бинарник: service + CLI, ТЗ §5).
 * CLI-вход: dist/cli.js (`evolve ...`); service (M2) поднимет HTTP по тому же API.
 */
export { loadConfig, resolveConfigPath, evolveConfigSchema, ConfigError, type EvolveConfig } from "./config/config.js";
export { EvolveError, InvalidTransitionError, NotFoundError, InvariantViolationError } from "./domain/errors.js";
export * from "./domain/types.js";
export { hashBody } from "./domain/hashing.js";
export {
  STATE_MACHINE,
  checkTransition,
  allowedTargets,
  actorClassOf,
  type TransitionEdge,
  type TransitionRequest,
  type ActorClass,
} from "./domain/state-machine.js";
export type { Store, StoreSnapshot, CreateItemInput, TransitionInput } from "./store/store.js";
export { MemoryStore } from "./store/memory-store.js";
export {
  admitCandidate,
  gateEvidence,
  gateDedup,
  gateConflict,
  gateScope,
  gateBudget,
  riskTierOf,
  type GateContext,
  type GateRunResult,
  type GateDecision,
  type AdmissionResult,
} from "./gates/gates.js";
export type { LlmClient, ConflictVerdict } from "./llm/client.js";
export { MockLlm, cosineSimilarity } from "./llm/client.js";
