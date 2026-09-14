#!/usr/bin/env node
/**
 * CLI `evolve` (TЗ §15 M0: item add/list/transition; §7.2.6: white-box show).
 * Единый бинарник: service + CLI (ТЗ §5) — service-часть подключается с M2.
 * M0: LLM — MockLlm (детерминированная); реальный LLM-API — M1 (ТЗ A4).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import process from "node:process";
import { Command } from "commander";
import { type ZodType } from "zod";
import { ConfigError, loadConfig, resolveConfigPath, type EvolveConfig } from "./config/config.js";
import { EvolveError } from "./domain/errors.js";
import { hashBody } from "./domain/hashing.js";
import {
  ITEM_TYPES,
  ITEM_STATUSES,
  RISK_TIERS,
  type Candidate,
  type Item,
  type ItemStatus,
  type ItemType,
  type ProvenanceSourceType,
} from "./domain/types.js";
import { STATE_MACHINE, allowedTargets, actorClassOf } from "./domain/state-machine.js";
import {
  knowledgeUsedSchema,
  taskStartedSchema,
  taskVerifiedSchema,
  TelemetryError,
} from "./domain/telemetry.js";
import { admitCandidate } from "./gates/gates.js";
import { MockExtractor, toDomainCandidate } from "./extractor/extractor.js";
import { buildQueueCard, listQueueCards } from "./queue/queue.js";
import { MockLlm } from "./llm/client.js";
import { MemoryStore } from "./store/memory-store.js";
import { PgStore } from "./store/pg-store.js";
import { asyncStoreOf, type AsyncStore } from "./store/async-store.js";
import { retrieve } from "./retrieval/search.js";
import { recomputeScores, itemScoreFor } from "./telemetry/score.js";
import { evaluateCanaries } from "./canary/canary.js";
import { runDecay } from "./decay/decay.js";
import { buildWeeklyReport, renderMarkdown } from "./report/report.js";
import { recordReview, type ReviewIssue } from "./review/review.js";
import { latestCriticWeight, recomputeCriticWeight } from "./critic/critic.js";
import { auditAgentAgnostic } from "./audit/agent-agnostic.js";
import { runTransferEval } from "./audit/transfer.js";
import { decideProposal, listProposals, runProposer, collectSignals } from "./meta/proposer.js";
import { insertProposals, MockHarnessProposer, validateProposals, type HarnessProposer } from "./llm/proposer.js";
import type { ItemType as CandidateType } from "./domain/types.js";
import { createRetrieveServer, formatResponse, type ResponseFormat } from "./service/retrieve.js";
import type { StoreSnapshot } from "./store/store.js";

const SOURCE_TYPES: readonly ProvenanceSourceType[] = ["success", "review", "critic", "human"];

function fail(err: unknown): never {
  if (err instanceof EvolveError || err instanceof ConfigError || err instanceof TelemetryError) {
    console.error(`[evolve] ${err.code}: ${err.message}`);
  } else {
    console.error("[evolve] INTERNAL:", err instanceof Error ? err.stack ?? err.message : String(err));
  }
  process.exit(1);
}

// --- персистентность M0: JSON-снимок (Postgres — M2) ---

function stateFilePath(): string {
  const fromEnv = process.env["EVOLVE_STATE"];
  return fromEnv && fromEnv.length > 0 ? fromEnv : path.join(".evolve", "state.json");
}

function isStoreSnapshot(x: unknown): x is StoreSnapshot {
  if (typeof x !== "object" || x === null) {
    return false;
  }
  const o = x as Record<string, unknown>;
  return Array.isArray(o["items"]) && typeof o["versions"] === "object" && typeof o["decisions"] === "object";
}

function loadStore(statePath: string): MemoryStore {
  if (!existsSync(statePath)) {
    return new MemoryStore();
  }
  const raw: unknown = JSON.parse(readFileSync(statePath, "utf8"));
  if (!isStoreSnapshot(raw)) {
    throw new EvolveError("STATE_INVALID", `состояние ${statePath} повреждено (не StoreSnapshot)`);
  }
  return MemoryStore.fromSnapshot(raw);
}

function saveStore(store: MemoryStore, statePath: string): void {
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(store.snapshot(), null, 2)}\n`, "utf8");
}

// --- форматирование вывода ---

function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…` : id;
}

/** Обязательный опциeнный вариант: commander гарантирует непустое для requiredOption. */
function req(opts: Record<string, unknown>, key: string): string {
  const v = opts[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new EvolveError("MISSING_OPTION", `--${key}: значение не передано`);
  }
  return v;
}

function indent(text: string, prefix = "    "): string {
  return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

// --- программа ---

const program = new Command().option("--db <url>", "Postgres connection string (memory-режим, если не задан)");
program
  .name("evolve")
  .description("Система эволюции знания для кодинг-агента (ТЗ knowledge-evolution-tz.md)")
  .option("--config <path>", "путь к config.yaml", resolveConfigPath())
  .option("--state <path>", "путь к файлу состояния (M0)", stateFilePath());

const item = new Command("item").description("операции с элементами базы знания");

interface ItemOptions {
  config?: string;
  state?: string;
}

interface Backend {
  store: AsyncStore;
  pg: PgStore | null;
  mem: MemoryStore | null;
  statePath: string;
}

function openBackend(opts: ItemOptions & { db?: string }): Backend {
  loadConfig(opts.config ?? resolveConfigPath()); // валидация конфига на старте
  const dbUrl = opts["db"];
  if (dbUrl && dbUrl.length > 0) {
    const pg = new PgStore({ connectionString: dbUrl });
    return { store: pg, pg, mem: null, statePath: "" };
  }
  const statePath = opts.state ?? stateFilePath();
  const mem = loadStore(statePath);
  return { store: asyncStoreOf(mem), pg: null, mem, statePath };
}

async function saveBackend(backend: Backend): Promise<void> {
  if (backend.mem && backend.statePath.length > 0) {
    saveStore(backend.mem, backend.statePath);
  }
}

async function closeBackend(backend: Backend): Promise<void> {
  await saveBackend(backend);
  if (backend.pg) {
    await backend.pg.close();
  }
}

item
  .command("add <title>")
  .description("создать кандидата и прогнать через гейты G1–G5 (ТЗ §9)")
  .requiredOption("--type <type>", `тип: ${ITEM_TYPES.join("|")}`)
  .requiredOption("--scope <scope>", "модуль/glob/'all' (G4)")
  .requiredOption("--body <text>", "тело знания")
  .requiredOption("--task-id <id>", "id исходной задачи (G1)")
  .requiredOption("--transcript-hash <hash>", "хеш транскрипта (G1)")
  .requiredOption("--commit <sha>", "git-коммит провенанса (G1)")
  .option("--verifier <name>", "верификатор успеха (tests|lint|smoke|human) — обязателен (G1)")
  .option("--source <source>", "источник: success|review|critic|human", "success")
  .option("--agent <agentId>", "ид агента (G5-лимиты)", "dsh")
  .option("--tags <tags>", "теги через запятую", "")
  .option("--applies-to <target>", "'all' | agent/model id", "all")
  .action(async (title: string, addOpts: Record<string, string | undefined>, cmd: Command) => {
    try {
      const type = req(addOpts, "type");
      if (!ITEM_TYPES.includes(type as ItemType)) {
        throw new EvolveError("INVALID_TYPE", `--type: допустимо ${ITEM_TYPES.join("|")}`);
      }
      const source = req(addOpts, "source");
      if (!SOURCE_TYPES.includes(source as ProvenanceSourceType)) {
        throw new EvolveError("INVALID_SOURCE", `--source: допустимо ${SOURCE_TYPES.join("|")}`);
      }
      const globalOpts = cmd.optsWithGlobals() as ItemOptions;
      const config = loadConfig(globalOpts.config ?? resolveConfigPath());
      const backend = openBackend(globalOpts);
      const store = backend.store;
      const candidate: Candidate = {
        type: type as ItemType,
        title,
        scope: req(addOpts, "scope"),
        tags: (addOpts["tags"] ?? "").split(",").map((t) => t.trim()).filter((t) => t.length > 0),
        appliesTo: req(addOpts, "appliesTo"),
        body: req(addOpts, "body"),
        provenance: {
          sourceType: source as ProvenanceSourceType,
          taskId: req(addOpts, "taskId"),
          transcriptHash: req(addOpts, "transcriptHash"),
          commit: req(addOpts, "commit"),
          payload: { verifier: addOpts["verifier"] ?? "" },
          createdAt: new Date().toISOString(),
        },
      };
      const candidateRef = `cand-${hashBody(candidate.body).slice(0, 8)}-${req(addOpts, "taskId")}`;
      const res = await admitCandidate({
        candidate,
        candidateRef,
        store,
        config,
        llm: new MockLlm(),
        clock: () => new Date(),
        agentId: req(addOpts, "agent"),
      });
      await saveBackend(backend);

      for (const g of res.gates.results) {
        console.log(`  [${g.outcome.toUpperCase().padEnd(4)}] ${g.gate.padEnd(8)} ${g.detail["reason"] ?? ""}`);
      }
      if (res.gates.decision === "reject") {
        console.log(`результат: reject — ${res.gates.reason}`);
        process.exit(1);
      }
      if (res.gates.decision === "merge") {
        console.log(`результат: merge — дубль item ${shortId(res.gates.mergeItemId ?? "")}, не создан новый элемент`);
        return;
      }
      const it = res.item as Item;
      console.log(`результат: accept (risk=${res.gates.riskTier}) → item ${shortId(it.id)} status=${it.status}`);
    } catch (err) {
      fail(err);
    }
  });

item
  .command("list")
  .description("список элементов (фильтры: --status, --type)")
  .option("--status <status>", `статус: ${ITEM_STATUSES.join("|")}`)
  .option("--type <type>", `тип: ${ITEM_TYPES.join("|")}`)
  .action(async (listOpts: { status?: string; type?: string }, cmd: Command) => {
    try {
      const globalOpts = cmd.optsWithGlobals() as ItemOptions;
      const backend = openBackend(globalOpts);
        const store = backend.store;
      const status = listOpts.status as ItemStatus | undefined;
      const type = listOpts.type as ItemType | undefined;
      if (status && !ITEM_STATUSES.includes(status)) {
        throw new EvolveError("INVALID_STATUS", `--status: допустимо ${ITEM_STATUSES.join("|")}`);
      }
      if (type && !ITEM_TYPES.includes(type)) {
        throw new EvolveError("INVALID_TYPE", `--type: допустимо ${ITEM_TYPES.join("|")}`);
      }
      const filter: { status?: ItemStatus; type?: ItemType } = {};
      if (status) {
        filter.status = status;
      }
      if (type) {
        filter.type = type;
      }
      const rows = await store.listItems(filter);
      if (rows.length === 0) {
        console.log("(пусто)");
        return;
      }
      for (const i of rows) {
        console.log(`${shortId(i.id)}  ${i.status.padEnd(10)} ${i.type.padEnd(14)} ${i.riskTier.padEnd(4)} ${i.scope}  ${i.title}`);
      }
    } catch (err) {
      fail(err);
    }
  });

item
  .command("show <id>")
  .description("white-box drill-down: body + провенанс + версии + decisions (ТЗ §7.2.6)")
  .action(async (id: string, _opts: unknown, cmd: Command) => {
    try {
      const globalOpts = cmd.optsWithGlobals() as ItemOptions;
      const backend = openBackend(globalOpts);
        const store = backend.store;
      const itemRow = await store.getItem(id);
      if (!itemRow) {
        throw new EvolveError("NOT_FOUND", `item ${id} не найден`);
      }
      console.log(`item ${itemRow.id}`);
      console.log(`  title:    ${itemRow.title}`);
      console.log(`  type:     ${itemRow.type}  status: ${itemRow.status}  risk: ${itemRow.riskTier}  v${itemRow.version}`);
      console.log(`  scope:    ${itemRow.scope}  applies_to: ${itemRow.appliesTo}  tags: [${itemRow.tags.join(", ")}]`);
      if (itemRow.archivedReason) {
        console.log(`  archived: ${itemRow.archivedReason}`);
      }
      console.log(`  body (v${itemRow.version}, обновлено ${itemRow.updatedAt}):`);
      console.log(indent(itemRow.body));
      const prov = await store.provenanceFor(itemRow.id);
      console.log(`  provenance (${prov.length}):`);
      for (const p of prov) {
        console.log(`    - source=${p.sourceType} task=${p.taskId} commit=${p.commit} verifier=${String(p.payload["verifier"] ?? "-")} (${p.createdAt})`);
      }
      const versions = await store.itemVersions(itemRow.id);
      console.log(`  versions: ${versions.map((v) => `v${v.version}${v.id === versions.at(-1)?.id ? " (current)" : ""}${v.supersededBy ? " (superseded)" : ""}`).join(", ")}`);
      const decisions = await store.decisionsFor(itemRow.id);
      console.log(`  decisions (${decisions.length}):`);
      for (const d of decisions) {
        console.log(`    - [${d.createdAt}] ${d.kind} actor=${d.actor} — ${d.reason}`);
      }
      const candidateRef = decisions[0]?.evidence["candidate_ref"];
      if (typeof candidateRef === "string") {
        const gates = await store.gateResultsFor(candidateRef);
        if (gates.length > 0) {
          console.log(`  gate_results (${candidateRef}):`);
          for (const g of gates) {
            console.log(`    - [${g.createdAt}] ${g.gate}: ${g.outcome} ${JSON.stringify(g.detail)}`);
          }
        }
      }
      const open = (await store.listContradictions({ status: "open" })).filter((c) => c.itemAId === itemRow.id || c.itemBId === itemRow.id);
      if (open.length > 0) {
        console.log(`  open contradictions: ${open.map((c) => `${c.id} (vs ${shortId(c.itemAId === itemRow.id ? c.itemBId : c.itemAId)})`).join(", ")}`);
      }
    } catch (err) {
      fail(err);
    }
  });

item
  .command("transition <id> <to>")
  .description(`сменить статус (разрешённые: см. allowed); --reason обязателен`)
  .requiredOption("--reason <text>", "почему (записывается в decisions)")
  .option("--actor <actor>", "actor: 'human' | 'auto:<gate>'", "human")
  .option("--kind <kind>", "kind решения (иначе — берётся из ребра стейт-машины)")
  .option("--archived-reason <text>", "обязателен при to=archived")
  .action(async (id: string, to: string, transOpts: Record<string, string | undefined>, cmd: Command) => {
    try {
      const toStatus = to as ItemStatus;
      if (!ITEM_STATUSES.includes(toStatus)) {
        throw new EvolveError("INVALID_STATUS", `допустимо: ${ITEM_STATUSES.join("|")}`);
      }
      const globalOpts = cmd.optsWithGlobals() as ItemOptions;
      const backend = openBackend(globalOpts);
      const store = backend.store;
      const current = await store.getItem(id);
      if (!current) {
        throw new EvolveError("NOT_FOUND", `item ${id} не найден`);
      }
      const edge = STATE_MACHINE[current.status].find((e) => e.to === toStatus);
      if (!edge) {
        throw new EvolveError(
          "INVALID_TRANSITION",
          `переход ${current.status} → ${toStatus} запрещён (допустимые: ${allowedTargets(current.status).join(", ") || "нет"})`,
        );
      }
      const kind = transOpts["kind"] ?? edge.kind;
      if (kind !== edge.kind) {
        throw new EvolveError("INVALID_KIND", `ребро требует kind='${edge.kind}'`);
      }
      const actor = transOpts["actor"] ?? "human";
      if (edge.actors.includes(actorClassOf(actor)) === false) {
        throw new EvolveError("INVALID_ACTOR", `переход ${current.status} → ${toStatus} недоступен actor-классу '${actorClassOf(actor)}'`);
      }
      const updated = await store.applyTransition(id, {
        to: toStatus,
        kind,
        actor,
        reason: transOpts["reason"] ?? "",
        evidence: { from: current.status },
        ...(toStatus === "archived" ? { archivedReason: transOpts["archivedReason"] ?? "" } : {}),
      });
      await saveBackend(backend);
      console.log(`${shortId(id)}: ${current.status} → ${updated.status} (kind=${kind}, actor=${actor})`);
    } catch (err) {
      fail(err);
    }
  });

// служебная команда: показать допустимые переходы из статуса
item
  .command("allowed <id>")
  .description("допустимые следующие статусы для item")
  .action(async (id: string, _opts: unknown, cmd: Command) => {
    try {
      const globalOpts = cmd.optsWithGlobals() as ItemOptions;
      const backend = openBackend(globalOpts);
        const store = backend.store;
      const it = await store.getItem(id);
      if (!it) {
        throw new EvolveError("NOT_FOUND", `item ${id} не найден`);
      }
      const targets = allowedTargets(it.status);
      console.log(`${shortId(id)} (${it.status}): ${targets.length === 0 ? "терминальный статус" : targets.join(", ")}`);
    } catch (err) {
      fail(err);
    }
  });

// --- телеметрия: события ТЗ §11.1 (M1) ---

const task = new Command("task").description("телеметрия задач: start / use / verify / show (ТЗ §11.1)");

function validated<T>(schema: ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new TelemetryError(
      "TELEMETRY_INVALID",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  return parsed.data;
}

task
  .command("start <taskId>")
  .description("task_started: регистрация задачи")
  .requiredOption("--agent <agentId>", "ид агента")
  .option("--scope-hints <hints>", "scope-подсказки через запятую", "")
  .action(async (taskId: string, opts: Record<string, string | undefined>, cmd: Command) => {
    try {
      const globalOpts = cmd.optsWithGlobals() as ItemOptions;
      const backend = openBackend(globalOpts);
      const store = backend.store;
      const event = validated(taskStartedSchema, {
        event: "task_started",
        task_id: taskId,
        agent_id: req(opts, "agent"),
        scope_hints: (opts["scopeHints"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        started_at: new Date().toISOString(),
      });
      await store.addEvent(event);
      await saveBackend(backend);
      console.log(`task_started: ${taskId} (agent=${event.agent_id})`);
    } catch (err) {
      fail(err);
    }
  });

task
  .command("use <taskId>")
  .description("knowledge_used: запись в usage_log ДО начала задачи (ТЗ §10.3)")
  .requiredOption("--agent <agentId>", "ид агента")
  .requiredOption("--item <id>", "id элемента (active/canary)")
  .action(async (taskId: string, opts: Record<string, string | undefined>, cmd: Command) => {
    try {
      const globalOpts = cmd.optsWithGlobals() as ItemOptions;
      const backend = openBackend(globalOpts);
      const store = backend.store;
      const itemRow = await store.getItem(req(opts, "item"));
      if (!itemRow) {
        throw new EvolveError("NOT_FOUND", `item ${req(opts, "item")} не найден`);
      }
      if (itemRow.status !== "active" && itemRow.status !== "canary") {
        throw new EvolveError(
          "ITEM_NOT_RETRIEVABLE",
          `item ${itemRow.id} в статусе ${itemRow.status}: извлекаются только active/canary (ТЗ §10.3)`,
        );
      }
      const event = validated(knowledgeUsedSchema, {
        event: "knowledge_used",
        task_id: taskId,
        item_id: itemRow.id,
        version: itemRow.version,
        agent_id: req(opts, "agent"),
        used_at: new Date().toISOString(),
      });
      await store.addEvent(event);
      await store.addUsage({
        id: `u-${hashBody(`${taskId}:${itemRow.id}:${itemRow.version}:${req(opts, "agent")}`).slice(0, 12)}`,
        itemId: itemRow.id,
        version: itemRow.version,
        agentId: event.agent_id,
        taskId,
        taskSuccess: null,
        retrievedAt: event.used_at,
      });
      await saveBackend(backend);
      console.log(`knowledge_used: ${taskId} ← item ${shortId(itemRow.id)} v${itemRow.version}`);
    } catch (err) {
      fail(err);
    }
  });

task
  .command("verify <taskId>")
  .description("task_verified: вердикт верификатора + backfill usage_log (ТЗ §11.4)")
  .requiredOption("--agent <agentId>", "ид агента")
  .option("--success", "задача успешна", false)
  .option("--fail", "задача неуспешна", false)
  .requiredOption("--verifier <v>", "tests|lint|smoke|human")
  .option("--verifier-id <id>", "конкретный верификатор (ablation, ТЗ §11.4)")
  .option("--human-override", "ручное переопределение вердикта", false)
  .action(async (taskId: string, opts: Record<string, string | boolean | undefined>, cmd: Command) => {
    try {
      if (Boolean(opts["success"]) === Boolean(opts["fail"])) {
        throw new TelemetryError("VERIFY_FLAGS", "укажите ровно одно из --success/--fail");
      }
      const globalOpts = cmd.optsWithGlobals() as ItemOptions;
      const backend = openBackend(globalOpts);
      const store = backend.store;
      const verifier = req(opts, "verifier");
      const event = validated(taskVerifiedSchema, {
        event: "task_verified",
        task_id: taskId,
        agent_id: req(opts, "agent"),
        success: Boolean(opts["success"]),
        verifier,
        verifier_id: (opts["verifierId"] as string | undefined) ?? verifier,
        ...(opts["humanOverride"] ? { human_override: true } : {}),
        verified_at: new Date().toISOString(),
      });
      await store.addEvent(event);
      const { updated, unchanged } = await store.backfillUsageForTask(taskId, event.success);
      await saveBackend(backend);
      console.log(
        `task_verified: ${taskId} success=${event.success} (${event.verifier}/${event.verifier_id}) — usage_log обновлено: ${updated}, без изменений: ${unchanged}`,
      );
    } catch (err) {
      fail(err);
    }
  });

task
  .command("show <taskId>")
  .description("события задачи + состояние usage_log")
  .action(async (taskId: string, _opts: unknown, cmd: Command) => {
    try {
      const globalOpts = cmd.optsWithGlobals() as ItemOptions;
      const backend = openBackend(globalOpts);
        const store = backend.store;
      const events = await store.listEvents({ taskId });
      if (events.length === 0) {
        console.log(`(нет событий для задачи ${taskId})`);
        return;
      }
      for (const e of events) {
        if (e.event === "task_started") {
          console.log(`- [${e.started_at}] task_started agent=${e.agent_id} hints=[${e.scope_hints.join(",")}]`);
        } else if (e.event === "knowledge_used") {
          console.log(`- [${e.used_at}] knowledge_used item=${shortId(e.item_id)} v${e.version} agent=${e.agent_id}`);
        } else if (e.event === "task_verified") {
          console.log(`- [${e.verified_at}] task_verified success=${e.success} verifier=${e.verifier}/${e.verifier_id}${e.human_override ? " (human_override)" : ""}`);
        } else {
          console.log(`- [${e.recorded_at}] review_recorded source=${e.source} rating=${e.rating} issues=${e.issues.length}`);
        }
      }
      const usage = await store.usageForTask(taskId);
      if (usage.length > 0) {
        console.log(`usage_log: ${usage.map((u) => `${shortId(u.itemId)}→${u.taskSuccess === null ? "?" : u.taskSuccess ? "success" : "fail"}`).join(", ")}`);
      }
    } catch (err) {
      fail(err);
    }
  });

const extract = new Command("extract").description(
  "экстрактор: транскрипт завершённой задачи → кандидаты → гейты (M1, ТЗ §8/§15)",
);

extract
  .command("run")
  .description("выполнить экстракцию и прогнать кандидатов через G1–G5")
  .requiredOption("--task-id <id>", "id завершённой задачи")
  .option("--transcript-file <path>", "файл с транскриптом")
  .option("--transcript <text>", "транскрипт строкой")
  .requiredOption("--verifier <v>", "верификатор успеха: tests|lint|smoke|human (G1)")
  .option("--verifier-id <id>", "конкретный верификатор", "")
  .option("--commit <sha>", "git-коммит задачи (провенанс)", "unknown")
  .option("--agent <agentId>", "ид агента", "dsh")
  .option("--scope-hints <hints>", "scope-подсказки через запятую", "")
  .action(async (opts: Record<string, string | undefined>, cmd: Command) => {
    try {
      const transcriptFile = opts["transcriptFile"];
      const transcriptArg = opts["transcript"];
      if (Boolean(transcriptFile) === Boolean(transcriptArg)) {
        throw new EvolveError("EXTRACT_TRANSCRIPT", "укажите ровно один из --transcript-file/--transcript");
      }
      const transcript = transcriptFile ? readFileSync(transcriptFile, "utf8") : (transcriptArg as string);
      if (transcript.trim().length === 0) {
        throw new EvolveError("EXTRACT_EMPTY", "транскрипт пуст");
      }
      const globalOpts = cmd.optsWithGlobals() as ItemOptions;
      const config = loadConfig(globalOpts.config ?? resolveConfigPath());
      const backend = openBackend(globalOpts);
      const store = backend.store;
      const taskId = req(opts, "taskId");
      const agentId = req(opts, "agent");
      const transcriptHash = `sha256:${hashBody(transcript)}`;

      const extraction = await new MockExtractor().extract({
        taskId,
        agentId,
        transcript,
        verifier: req(opts, "verifier"),
        verifierId: (opts["verifierId"] as string | undefined) ?? req(opts, "verifier"),
        scopeHints: (opts["scopeHints"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      });
      if (extraction.candidates.length === 0) {
        console.log(`кандидатов не извлечено. notes: ${extraction.notes || "—"}`);
        await saveBackend(backend);
        return;
      }
      console.log(`извлечено кандидатов: ${extraction.candidates.length}`);
      let accepted = 0;
      let rejected = 0;
      let merged = 0;
      for (const [i, ext] of extraction.candidates.entries()) {
        const candidate = toDomainCandidate(ext, {
          sourceType: "success",
          taskId,
          transcriptHash,
          commit: req(opts, "commit"),
          payload: { verifier: req(opts, "verifier"), verifier_id: (opts["verifierId"] as string | undefined) ?? req(opts, "verifier") },
          createdAt: new Date().toISOString(),
        });
        const candidateRef = `ext-${hashBody(transcript).slice(0, 8)}-${i}-${taskId}`;
        const res = await admitCandidate({
          candidate,
          candidateRef,
          store,
          config,
          llm: new MockLlm(),
          clock: () => new Date(),
          agentId,
        });
        if (res.gates.decision === "accept") {
          accepted += 1;
          console.log(`  [${i}] accept (risk=${res.gates.riskTier}) → ${shortId((res.item as Item).id)} ${res.item?.status} — ${candidate.title}`);
        } else if (res.gates.decision === "merge") {
          merged += 1;
          console.log(`  [${i}] merge → ${shortId(res.gates.mergeItemId ?? "")} — ${candidate.title}`);
        } else {
          rejected += 1;
          console.log(`  [${i}] reject — ${res.gates.reason} — ${candidate.title}`);
        }
      }
      if (extraction.notes.length > 0) {
        console.log(`notes: ${extraction.notes}`);
      }
      await saveBackend(backend);
      console.log(`итого: accept=${accepted}, merge=${merged}, reject=${rejected}`);
      if (accepted === 0 && merged === 0) {
        process.exit(1);
      }
    } catch (err) {
      fail(err);
    }
  });

// --- очередь high-risk (ТЗ §12.1: недельное окно) ---

const queue = new Command("queue").description("очередь high-risk: карточки, принять/отклонить (ТЗ §12.1)");

queue
  .command("list")
  .description("карточки очереди (age, цена бездействия, stale)")
  .action(async (_opts: unknown, cmd: Command) => {
    try {
      const globalOpts = cmd.optsWithGlobals() as ItemOptions;
      const config = loadConfig(globalOpts.config ?? resolveConfigPath());
      const backend = openBackend(globalOpts);
        const store = backend.store;
      const cards = await listQueueCards(store, config, new Date());
      if (cards.length === 0) {
        console.log("(очередь пуста)");
        return;
      }
      for (const c of cards) {
        const flags: string[] = [];
        if (c.stale) {
          flags.push(`STALE>${config.alerts.queue_card_max_days}д`);
        }
        if (c.openContradictions.length > 0) {
          flags.push(`contradictions=${c.openContradictions.length}`);
        }
        const prov = c.provenanceRefs[0];
        console.log(
          `${shortId(c.item.id)}  ${c.item.type.padEnd(14)} ${c.item.riskTier.padEnd(4)} age=${c.daysInQueue}д cost=${c.costOfInaction} ${c.item.scope}  ${c.item.title}  [task=${prov?.taskId ?? "-"} commit=${prov?.commit ?? "-"}]${flags.length > 0 ? ` (${flags.join(", ")})` : ""}`,
        );
      }
    } catch (err) {
      fail(err);
    }
  });

queue
  .command("show <id>")
  .description("полная карточка: body, провенанс, гейты, противоречия (ТЗ §12.1)")
  .action(async (id: string, _opts: unknown, cmd: Command) => {
    try {
      const globalOpts = cmd.optsWithGlobals() as ItemOptions;
      const config = loadConfig(globalOpts.config ?? resolveConfigPath());
      const backend = openBackend(globalOpts);
        const store = backend.store;
      const itemRow = await store.getItem(id);
      if (!itemRow || itemRow.status !== "queued") {
        throw new EvolveError("NOT_IN_QUEUE", `item ${id} не в очереди (статус: ${itemRow?.status ?? "нет"})`);
      }
      const card = await buildQueueCard(itemRow, store, config, new Date());
      console.log(`карточка ${itemRow.id} — ${itemRow.title}`);
      console.log(`  type=${itemRow.type} risk=${itemRow.riskTier} scope=${itemRow.scope} age=${card.daysInQueue}д costOfInaction=${card.costOfInaction}${card.stale ? ` [STALE > ${config.alerts.queue_card_max_days}д]` : ""}`);
      console.log(`  body:`);
      console.log(indent(itemRow.body));
      console.log(`  provenance:`);
      for (const p of card.provenanceRefs) {
        console.log(`    - source=${p.sourceType} task=${p.taskId} commit=${p.commit} verifier=${String(p.payload["verifier"] ?? "-")}`);
      }
      if (card.gateResults.length > 0) {
        console.log(`  gates: ${card.gateResults.map((g) => `${g.gate}=${g.outcome}`).join(", ")}`);
      }
      if (card.openContradictions.length > 0) {
        console.log(`  противоречия:`);
        for (const c of card.openContradictions) {
          const otherId = c.itemAId === itemRow.id ? c.itemBId : c.itemAId;
          console.log(`    - vs ${shortId(otherId)} (severity=${c.severity}, ${c.id})`);
        }
      }
      const queueDecisions = await store.decisionsFor(itemRow.id);
      console.log(`  решения: ${queueDecisions.map((d) => `${d.kind}(${d.actor})`).join(", ")}`);
    } catch (err) {
      fail(err);
    }
  });

queue
  .command("accept <id>")
  .description("принять: queued → canary (actor=human)")
  .option("--reason <text>", "причина (в decisions)", "принято в недельном окне")
  .action(async (id: string, opts: Record<string, string | undefined>, cmd: Command) => {
    try {
      const globalOpts = cmd.optsWithGlobals() as ItemOptions;
      const backend = openBackend(globalOpts);
      const store = backend.store;
      const updated = await store.applyTransition(id, {
        to: "canary",
        kind: "promote",
        actor: "human",
        reason: req(opts, "reason"),
        evidence: { source: "queue" },
      });
      await saveBackend(backend);
      console.log(`${shortId(id)}: queued → ${updated.status} (actor=human)`);
    } catch (err) {
      fail(err);
    }
  });

queue
  .command("accept-edit <id>")
  .description("принять с правкой: новая версия (approve_edit) + queued → canary")
  .requiredOption("--body <text>", "новое тело знания")
  .option("--reason <text>", "почему правка (в decisions)", "принято с правкой в недельном окне")
  .action(async (id: string, opts: Record<string, string | undefined>, cmd: Command) => {
    try {
      const globalOpts = cmd.optsWithGlobals() as ItemOptions;
      const backend = openBackend(globalOpts);
      const store = backend.store;
      const updated = await store.addVersion(id, req(opts, "body"), {
        kind: "approve_edit",
        actor: "human",
        reason: req(opts, "reason"),
        evidence: { source: "queue" },
      });
      const after = await store.applyTransition(id, {
        to: "canary",
        kind: "promote",
        actor: "human",
        reason: "принято с правкой → canary (ТЗ §12.1)",
        evidence: { version: updated.version },
      });
      await saveBackend(backend);
      console.log(`${shortId(id)}: v${after.version}, queued → ${after.status} (actor=human)`);
    } catch (err) {
      fail(err);
    }
  });

queue
  .command("reject <id>")
  .description("отклонить: queued → archived, причина обязательная (ТЗ §12.1)")
  .requiredOption("--reason <text>", "причина отклонения (строится в decisions; экстрактор учитывает частые причины)")
  .action(async (id: string, opts: Record<string, string | undefined>, cmd: Command) => {
    try {
      const globalOpts = cmd.optsWithGlobals() as ItemOptions;
      const backend = openBackend(globalOpts);
      const store = backend.store;
      const updated = await store.applyTransition(id, {
        to: "archived",
        kind: "reject",
        actor: "human",
        reason: req(opts, "reason"),
        archivedReason: req(opts, "reason"),
        evidence: { source: "queue" },
      });
      await saveBackend(backend);
      console.log(`${shortId(id)}: queued → ${updated.status} (actor=human, reason: ${req(opts, "reason")})`);
    } catch (err) {
      fail(err);
    }
  });

program.addCommand(item);
program.addCommand(task);
program.addCommand(extract);
program.addCommand(queue);

process.on("unhandledRejection", (reason) => {
  console.error("[evolve] unhandledRejection:", reason instanceof Error ? reason.stack ?? reason.message : String(reason));
  process.exit(1);
});


// --- миграции Postgres (M2, ТЗ §7.1) ---

const DEFAULT_DB_URL = process.env["EVOLVE_DB_URL"] ?? "postgres://arka@127.0.0.1:5432/evolve";

const migrateCmd = new Command("migrate")
  .description("применить миграции db/migrations/ к Postgres (идемпотентно, schema_migrations)")
  .option("--db <url>", "connection string (default EVOLVE_DB_URL или postgres://arka@127.0.0.1:5432/evolve)");

migrateCmd.action(async (opts: Record<string, string | undefined>) => {
  try {
    const dbUrl = opts["db"] ?? DEFAULT_DB_URL;
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const dir = path.join(root, "db", "migrations");
    if (!existsSync(dir)) {
      throw new EvolveError("MIGRATIONS_NOT_FOUND", `каталог миграций не найден: ${dir}`);
    }
    const pool = new Pool({ connectionString: dbUrl, max: 2 });
    try {
      const client = await pool.connect();
      try {
        await client.query(
          `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
        );
        const applied = new Set(
          (await client.query(`SELECT name FROM schema_migrations`)).rows.map((r) => r["name"] as string),
        );
        const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
        let n = 0;
        for (const f of files) {
          if (applied.has(f)) {
            console.log(`= ${f} — уже применено`);
            continue;
          }
          const sql = readFileSync(path.join(dir, f), "utf8");
          await client.query("BEGIN");
          try {
            await client.query(sql);
            await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [f]);
            await client.query("COMMIT");
          } catch (err) {
            await client.query("ROLLBACK");
            throw err;
          }
          console.log(`✓ ${f} — применено`);
          n += 1;
        }
        console.log(`миграций применено: ${n} (всего файлов: ${files.length})`);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  } catch (err) {
    fail(err);
  }
});

const retrieveCmd = new Command("retrieve")
  .description("retrieval: запрос → знания (M2, ТЗ §10); источник — Postgres")
  .requiredOption("--query <q>", "запрос (вопрос/описание задачи)")
  .option("--agent <agentId>", "ид агента", "dsh")
  .option("--task-id <id>", "id задачи (запишет usage_log)")
  .option("--scope-hints <hints>", "scope-подсказки через запятую", "")
  .option("--db <url>", "connection string", DEFAULT_DB_URL)
  .option("--format <fmt>", "json|markdown", "json");

retrieveCmd.action(async (opts: Record<string, string | undefined>) => {
  try {
    const config = loadConfig((opts as ItemOptions).config ?? resolveConfigPath());
    const store = new PgStore({ connectionString: opts["db"] ?? DEFAULT_DB_URL });
    try {
      const result = await retrieve(
        store.pool,
        {
          query: req(opts, "query"),
          agentId: req(opts, "agent"),
          taskId: (opts["taskId"] as string | undefined) ?? undefined,
          scopeHints: (opts["scopeHints"] ?? "").split(",").map((s2) => s2.trim()).filter(Boolean),
        },
        config,
        new MockLlm(),
      );
      const out = formatResponse(result, (opts["format"] ?? "json") as ResponseFormat, null);
      console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
      if (result.timedOut) {
        process.exitCode = 2;
      }
    } finally {
      await store.close();
    }
  } catch (err) {
    fail(err);
  }
});

const serveCmd = new Command("serve")
  .description("retrieval-сервис: HTTP POST /retrieve + GET /health (ТЗ §10)")
  .option("--port <port>", "порт", "3100")
  .option("--db <url>", "connection string", DEFAULT_DB_URL);

serveCmd.action(async (opts: Record<string, string | undefined>) => {
  try {
    const config = loadConfig((opts as ItemOptions).config ?? resolveConfigPath());
    const store = new PgStore({ connectionString: opts["db"] ?? DEFAULT_DB_URL });
    const server = createRetrieveServer({ pool: store.pool, config, llm: new MockLlm() });
    const port = Number.parseInt(opts["port"] ?? "3100", 10);
    server.listen(port, () => {
      console.log(`evolve serve: http://127.0.0.1:${port} (mode=${config.retrieval.mode}, db=${opts["db"] ?? DEFAULT_DB_URL})`);
    });
    const shutdown = async (): Promise<void> => {
      server.close();
      await store.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  } catch (err) {
    fail(err);
  }
});

const canaryCmd = new Command("canary").description("canary-цикл: авто-решения по canary-элементам (ТЗ §9)");

canaryCmd
  .command("evaluate")
  .description("прогнать canary-оценку (окно 7д / min_retrievals / ε / cost-gate)")
  .option("--db <url>", "connection string", DEFAULT_DB_URL)
  .action(async (opts: Record<string, string | undefined>) => {
    try {
      const config = loadConfig((opts as ItemOptions).config ?? resolveConfigPath());
      const store = new PgStore({ connectionString: opts["db"] ?? DEFAULT_DB_URL });
      try {
        const verdicts = await evaluateCanaries(store, config, new Date());
        if (verdicts.length === 0) {
          console.log("(canary-элементов нет)");
          return;
        }
        for (const v of verdicts) {
          console.log(`${v.outcome.padEnd(7)} ${v.itemId.slice(0, 8)}… — ${v.title} — ${v.reason}`);
        }
      } finally {
        await store.close();
      }
    } catch (err) {
      fail(err);
    }
  });

const scoresCmd = new Command("scores").description("score по (item, agent) из usage_log (ТЗ §11.3)");

scoresCmd
  .command("recompute")
  .description("идемпотентный пересчёт всех score + score_global")
  .option("--db <url>", "connection string", DEFAULT_DB_URL)
  .action(async (opts: Record<string, string | undefined>) => {
    try {
      const config = loadConfig((opts as ItemOptions).config ?? resolveConfigPath());
      const store = new PgStore({ connectionString: opts["db"] ?? DEFAULT_DB_URL });
      try {
        const n = await recomputeScores(store.pool, config, new Date());
        console.log(`пересчитано пар (item, agent): ${n}`);
      } finally {
        await store.close();
      }
    } catch (err) {
      fail(err);
    }
  });

scoresCmd
  .command("show <id>")
  .description("score элемента: per-agent + global")
  .option("--agent <agentId>", "ид агента", "dsh")
  .option("--db <url>", "connection string", DEFAULT_DB_URL)
  .action(async (id: string, opts: Record<string, string | undefined>) => {
    try {
      const store = new PgStore({ connectionString: opts["db"] ?? DEFAULT_DB_URL });
      try {
        const item = await store.getItem(id);
        if (!item) {
          throw new EvolveError("NOT_FOUND", `item ${id} не найден`);
        }
        const agent = await itemScoreFor(store.pool, id, req(opts, "agent"));
        console.log(`item ${shortId(id)} (${item.status}, ${item.type})`);
        console.log(`  score_global=${item.scoreGlobal.toFixed(3)}`);
        console.log(`  score(${req(opts, "agent")})=${agent.score.toFixed(3)} (source=${agent.source})`);
      } finally {
        await store.close();
      }
    } catch (err) {
      fail(err);
    }
  });

const decayCmd = new Command("decay").description("decay/деградация: daily-логика + over-pruning guard (ТЗ §9/§16)");

decayCmd
  .command("run")
  .description("прогнать decay: unused 21д / θ_score / deprecated 30д → archived / contradiction 7д → queue")
  .option("--db <url>", "connection string", DEFAULT_DB_URL)
  .action(async (opts: Record<string, string | undefined>) => {
    try {
      const config = loadConfig((opts as ItemOptions).config ?? resolveConfigPath());
      const store = new PgStore({ connectionString: opts["db"] ?? DEFAULT_DB_URL });
      try {
        const actions = await runDecay(store, config, new Date());
        if (actions.length === 0) {
          console.log("(действий не требуется)");
          return;
        }
        for (const a of actions) {
          console.log(`${a.kind.padEnd(20)} ${a.itemId.slice(0, 8)}… — ${a.title} — ${a.reason}`);
        }
      } finally {
        await store.close();
      }
    } catch (err) {
      fail(err);
    }
  });

const rollbackCmd = new Command("rollback <id>")
  .description("rollback авто-решения одним кликом (ТЗ §12.1/§15 M3): deprecated → active")
  .option("--reason <text>", "причина (аудит)")
  .option("--db <url>", "connection string", DEFAULT_DB_URL);

rollbackCmd.action(async (id: string, opts: Record<string, string | undefined>, cmd: Command) => {
  try {
    const globalOpts = cmd.optsWithGlobals() as ItemOptions;
    const backend = openBackend(globalOpts);
    const store = backend.store;
    const item = await store.getItem(id);
    if (!item) {
      throw new EvolveError("NOT_FOUND", `item ${id} не найден`);
    }
    if (item.status !== "deprecated") {
      throw new EvolveError("INVALID_STATE", `rollback доступен только из status=deprecated (текущий: ${item.status})`);
    }
    const reason = opts["reason"] ?? "rollback авто-решения (ТЗ §12.1): возвращение в active";
    const updated = await store.applyTransition(id, {
      to: "active", kind: "rollback", actor: "human", reason,
      evidence: { rolled_back_from: "deprecated" },
    });
    console.log(`rollback: ${shortId(updated.id)} → active (v${updated.version})`);
    await closeBackend(backend);
  } catch (err) {
    fail(err);
  }
});

const reportCmd = new Command("report").description("отчётность: недельное окно + алерты (ТЗ §12/§15 M3)");

reportCmd
  .command("weekly")
  .description("недельный отчёт: success-rate, canary, churn, очередь, алерты")
  .option("--json", "вывод JSON")
  .option("--db <url>", "connection string", DEFAULT_DB_URL)
  .action(async (opts: Record<string, string | undefined>) => {
    try {
      const config = loadConfig((opts as ItemOptions).config ?? resolveConfigPath());
      const store = new PgStore({ connectionString: opts["db"] ?? DEFAULT_DB_URL });
      try {
        const report = await buildWeeklyReport(store.pool, config, new Date());
        if (opts["json"]) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(renderMarkdown(report));
        }
      } finally {
        await store.close();
      }
    } catch (err) {
      fail(err);
    }
  });

const reviewCmd = new Command("review").description("review-триггер: фидбэк человека/критика → конвейер (ТЗ §13, M4)");

const reviewRecord = new Command("record")
  .description("записать review (rating 1..5 + issues) и прогнать lesson-кандидаты через гейты")
  .requiredOption("--task-id <id>", "задача, по которой ревью")
  .requiredOption("--source <human|critic>", "источник фидбэка")
  .requiredOption("--rating <n>", "оценка 1..5")
  .requiredOption("--transcript-hash <hash>", "hash транскрипта просмотренной задачи")
  .option("--commit <sha>", "коммит задачи", "none")
  .option("--lesson <text>", "lesson_candidate (issue → кандидат)")
  .option("--issue-type <bug|design|missing|style|other>", "тип issue", "other")
  .option("--issue-severity <low|med|high>", "серьёзность issue", "med")
  .option("--evidence <text>", "доказательство issue (file:line / тест / цитата)", "")
  .option("--type <skill|heuristic|negative|fact|tool_proposal>", "тип кандидата", "heuristic")
  .option("--scope <glob>", "scope кандидата", "all")
  .option("--applies-to <agent|all>", "applies_to кандидата", "all")
  .option("--agent <agentId>", "агент задачи", "dsh");

reviewRecord.action(async (opts: Record<string, string | undefined>, cmd: Command) => {
  try {
    const globalOpts = cmd.optsWithGlobals() as ItemOptions;
    const backend = openBackend(globalOpts);
    const store = backend.store;
    const config = loadConfig(globalOpts.config ?? resolveConfigPath());
    const source = req(opts, "source");
    if (source !== "human" && source !== "critic") {
      throw new EvolveError("REVIEW_BAD_SOURCE", `--source: ${source} (human|critic)`);
    }
    const rating = Number(req(opts, "rating"));
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new EvolveError("REVIEW_BAD_RATING", `--rating: ${opts["rating"]} (1..5)`);
    }
    const lesson = opts["lesson"];
    const latestWeight =
      backend.pg != null && source === "critic" ? await latestCriticWeight(backend.pg.pool) : null;
    const issue: ReviewIssue = {
      type: (opts["issueType"] as ReviewIssue["type"] | undefined) ?? "other",
      severity: (opts["issueSeverity"] as ReviewIssue["severity"] | undefined) ?? "med",
      evidence: opts["evidence"] ?? "",
      ...(lesson != null ? { lessonCandidate: lesson } : {}),
    };
    const outcome = await recordReview(
      store,
      config,
      {
        taskId: req(opts, "taskId"),
        source,
        agentId: req(opts, "agent"),
        rating,
        transcriptHash: req(opts, "transcriptHash"),
        commit: opts["commit"] ?? "none",
        issues: [issue],
        llm: new MockLlm(),
        ...(opts["type"] != null ? { type: opts["type"] as CandidateType } : {}),
        ...(opts["scope"] != null ? { scope: opts["scope"] } : {}),
        ...(opts["appliesTo"] != null ? { appliesTo: opts["appliesTo"] } : {}),
        ...(latestWeight != null ? { criticWeight: latestWeight } : {}),
      },
      new Date(),
    );
    console.log(`review_recorded: ${req(opts, "taskId")} source=${source} rating=${rating} issues=1`);
    for (const r of outcome.candidates) {
      if (r.gates.decision === "accept") {
        console.log(`  [accept] risk=${r.gates.riskTier} → item ${shortId((r.item as { id: string }).id)} status=${r.item?.status}`);
      } else if (r.gates.decision === "merge") {
        console.log(`  [merge] дубль item ${shortId(r.gates.mergeItemId ?? "")}, не создан новый элемент`);
      } else {
        const failed = r.gates.results.find((g) => g.outcome === "fail");
        console.log(`  [reject] ${failed ? failed.gate + ": " + String(failed.detail["reason"] ?? "") : r.gates.reason ?? ""}`);
      }
    }
    await closeBackend(backend);
  } catch (err) {
    fail(err);
  }
});

reviewCmd.addCommand(reviewRecord);
program.addCommand(reviewCmd);
const criticCmd = new Command("critic").description("критик-агент: авто-вес по телеметрии (ТЗ §13, M4.2)");

criticCmd
  .command("reweight")
  .description("пересчёт critic_weight: gate-pass-rate lesson-кандидатов × usage-фактор")
  .option("--db <url>", "connection string", DEFAULT_DB_URL)
  .action(async (opts: Record<string, string | undefined>) => {
    try {
      const config = loadConfig((opts as ItemOptions).config ?? resolveConfigPath());
      const store = new PgStore({ connectionString: opts["db"] ?? DEFAULT_DB_URL });
      try {
        const stats = await recomputeCriticWeight(store, config, new Date());
        const prev = stats.previousWeight == null ? "нет" : stats.previousWeight.toFixed(2);
        console.log(`critic_weight: ${prev} → ${stats.weight.toFixed(2)}`);
        console.log(`  gate-pass: ${stats.gatePassRate == null ? "н/д" : `${(100 * stats.gatePassRate).toFixed(0)}%`} (lessons ${stats.lessons}, приняты ${stats.accepted})`);
        console.log(`  usage-фактор: ${stats.usageFactor.toFixed(2)} (verdicts ${stats.criticVerdicts}; critic_sr ${stats.criticSuccessRate == null ? "н/д" : stats.criticSuccessRate.toFixed(2)}, baseline ${stats.baselineSuccessRate == null ? "н/д" : stats.baselineSuccessRate.toFixed(2)})`);
      } finally {
        await store.close();
      }
    } catch (err) {
      fail(err);
    }
  });

const auditCmd = new Command("audit").description("аудит hard-requirements (ТЗ §14: agent-agnostic)");

auditCmd
  .command("agent-agnostic")
  .description("проверка ТЗ §14: без хардкода агентов, applies_to, score-на-паре, профили")
  .option("--db <url>", "connection string (добавляет проверки живой БД)")
  .action(async (opts: Record<string, string | undefined>, cmd: Command) => {
    try {
      loadConfig(resolveConfigPath());
      const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
      // --db декларирован и на программе (глобально): читаем из optsWithGlobals.
      const dbUrl = (opts["db"] as string | undefined) ?? (cmd.optsWithGlobals() as ItemOptions & { db?: string })["db"];
      let pool: Pool | undefined;
      if (dbUrl) {
        pool = new Pool({ connectionString: dbUrl });
      }
      try {
        const checks = await auditAgentAgnostic(root, pool);
        let failed = 0;
        for (const c of checks) {
          console.log(`${c.ok ? "✓" : "✗"} ${c.id}: ${c.detail}`);
          if (!c.ok) {
            failed += 1;
          }
        }
        console.log(failed === 0 ? "agent-agnostic: все проверки пройдены (ТЗ §14)" : `agent-agnostic: ${failed} проверок не пройдено`);
        if (failed > 0) {
          process.exit(1);
        }
      } finally {
        if (pool) {
          await pool.end();
        }
      }
    } catch (err) {
      fail(err);
    }
  });

const transferCmd = new Command("transfer")
  .description("transfer-тест: top-20 active на альтернативном профиле (ТЗ §14.5, M5)");

transferCmd
  .command("eval")
  .description("self-recall top-20 active-элементов на альтернативном agent_profile; weak → тег transfer:weak")
  .requiredOption("--profile <agentId>", "альтернативный agent_profile")
  .option("--limit <n>", "размер подвыборки", "20")
  .option("--db <url>", "connection string", DEFAULT_DB_URL)
  .action(async (opts: Record<string, string | undefined>) => {
    try {
      const config = loadConfig((opts as ItemOptions).config ?? resolveConfigPath());
      const store = new PgStore({ connectionString: opts["db"] ?? DEFAULT_DB_URL });
      try {
        const limit = Number(opts["limit"] ?? 20);
        const summary = await runTransferEval(store, config, new MockLlm(), new Date(), req(opts, "profile"), limit);
        console.log(`transfer-тест: профиль '${summary.profileAgent}', top-${summary.total}: transferred ${summary.transferred}, weak ${summary.weak}`);
        for (const r of summary.results) {
          const mark = r.verdict === "transferred" ? "✓" : "✗";
          console.log(`${mark} ${r.itemId.slice(0, 8)}… ${r.title} (applies_to=${r.appliesTo}, ${r.verdict}${r.weakTagged ? ", +transfer:weak" : ""})`);
        }
      } finally {
        await store.close();
      }
    } catch (err) {
      fail(err);
    }
  });

const ablationCmd = new Command("ablation")
  .description("ablation-модули (ТЗ §12.4): режим off на неделю, смена = коммит конфига");

ablationCmd
  .command("list")
  .description("статус ablation-флагов из конфига (dedup/conflict/canary/critic/negative)")
  .action(async (opts: Record<string, string | undefined>, cmd: Command) => {
    try {
      const globalOpts = cmd.optsWithGlobals() as ItemOptions;
      const config = loadConfig(globalOpts.config ?? resolveConfigPath());
      const modules: Record<string, string> = {
        dedup: "G2 (дубли — merge-предложения)",
        conflict: "G3 (детектор противоречий)",
        canary: "canary (авто-промоут; off → low в queue)",
        critic: "критик (lesson-кандидаты критика)",
        negative: "negative-элементы в выдаче retrieval",
      };
      for (const [k, desc] of Object.entries(modules)) {
        const on = config.ablation[k as keyof typeof config.ablation];
        console.log(`${on ? "on " : "OFF"}  ${k.padEnd(8)} — ${desc}`);
      }
      console.log("смена флага = правка config.yaml + коммит (change control, harness.md §6)");
    } catch (err) {
      fail(err);
    }
  });

const metaCmd = new Command("meta")
  .description("meta-оптимизация: proposer предлагает правки harness в очередь человека (ТЗ §15/M6)");

metaCmd
  .command("propose")
  .description("прогнать proposer: сигналы 30 дней → кандидаты правок (тема/поле/old→new/rationale)")
  .option("--llm", "дополнительно: LLM-пропонер (M6.2; mock-реализация, валидация + очередь человека)")
  .option("--db <url>", "connection string", DEFAULT_DB_URL)
  .action(async (opts: Record<string, string | undefined>, cmd: Command) => {
    try {
      const config = loadConfig((cmd.optsWithGlobals() as ItemOptions).config ?? resolveConfigPath());
      const dbUrl = (opts["db"] as string | undefined) ?? (cmd.optsWithGlobals() as ItemOptions & { db?: string })["db"] ?? DEFAULT_DB_URL;
      const pool = new Pool({ connectionString: dbUrl });
      try {
        const res = await runProposer(pool, config, new Date());
        let totalCreated = res.created.length;
        let totalSkipped = res.skippedDuplicates;
        for (const p of res.created) {
          console.log(`+ ${p.field}: ${p.oldValue} → ${p.newValue} (${p.target})`);
          console.log(`  ${p.rationale}`);
          console.log(`  evidence: ${JSON.stringify(p.evidence)}`);
        }
        if (opts["llm"]) {
          // M6.2: LLM-пропонер поверх правил (промпт = телеметрия + вырез harness.md).
          // Реальный LLM — реализация HarnessProposer; здесь — детерминированный mock.
          const proposer: HarnessProposer = new MockHarnessProposer();
          const signals = await collectSignals(pool, config, new Date());
          const harnessDoc = readFileSync(
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "harness.md"),
            "utf8",
          );
          const raw = await proposer.propose({
            telemetry: signals,
            config: config as unknown as Record<string, unknown>,
            harnessDoc,
          });
          const report = validateProposals(raw, config);
          for (const r of report.rejected) {
            console.log(`✗ (llm ${proposer.name}) ${r.field}: ${r.reason}`);
          }
          const inserted = await insertProposals(pool, report.accepted, "harness.md (llm, M6.2)");
          totalCreated += inserted.created;
          totalSkipped += inserted.skippedDuplicates;
          for (const p of report.accepted) {
            console.log(`+ (llm ${proposer.name}) ${p.field}: ${p.oldValue} → ${p.newValue}`);
            console.log(`  ${p.rationale}`);
          }
          if (inserted.skippedDuplicates > 0) {
            console.log(`(llm) пропущено дубликатов (уже в очереди): ${inserted.skippedDuplicates}`);
          }
        }
        if (totalCreated === 0) {
          console.log(`предложений нет${totalSkipped > 0 ? ` (пропущено дубликатов: ${totalSkipped})` : ""}`);
        } else {
          if (totalSkipped > 0) {
            console.log(`пропущено дубликатов (уже в очереди): ${totalSkipped}`);
          }
          console.log("кандидаты в очереди: meta proposals; решение — человек + метрики (harness.md §9)");
        }
      } finally {
        await pool.end();
      }
    } catch (err) {
      fail(err);
    }
  });

metaCmd
  .command("proposals")
  .description("очередь кандидатов правок harness")
  .option("--status <s>", "фильтр: proposed|accepted|rejected|applied")
  .option("--db <url>", "connection string", DEFAULT_DB_URL)
  .action(async (opts: Record<string, string | undefined>, cmd: Command) => {
    try {
      const dbUrl = (opts["db"] as string | undefined) ?? (cmd.optsWithGlobals() as ItemOptions & { db?: string })["db"] ?? DEFAULT_DB_URL;
      const pool = new Pool({ connectionString: dbUrl });
      try {
        const rows = await listProposals(pool, (opts["status"] as string | undefined) ?? "proposed");
        if (rows.length === 0) {
          console.log("очередь пуста");
          return;
        }
        for (const r of rows) {
          console.log(`${String(r["status"]).padEnd(9)} ${String(r["field"]).padEnd(20)} ${String(r["old_value"])} → ${String(r["new_value"])}`);
          console.log(`  id=${String(r["id"]).slice(0, 8)}… ${r["rationale"]}`);
        }
      } finally {
        await pool.end();
      }
    } catch (err) {
      fail(err);
    }
  });

const decideOpts = (opts: Record<string, string | undefined>, cmd: Command): { pool: Pool; id: string; by: string; notes: string } => {
  const dbUrl = (opts["db"] as string | undefined) ?? (cmd.optsWithGlobals() as ItemOptions & { db?: string })["db"] ?? DEFAULT_DB_URL;
  const id = opts["id"] as string;
  const by = (opts["by"] as string | undefined) ?? "human:cli";
  const notes = (opts["notes"] as string | undefined) ?? "";
  return { pool: new Pool({ connectionString: dbUrl }), id, by, notes };
};

metaCmd
  .command("apply <id>")
  .description("решение человека: правка применена (дальше — правка config.yaml/harness.md в git + commit)")
  .option("--by <name>", "кто решил (human:…)")
  .option("--notes <text>", "заметка (ссылка на данные, golden-эвалуацию)")
  .option("--db <url>", "connection string", DEFAULT_DB_URL)
  .action(async (id: string, opts: Record<string, string | undefined>, cmd: Command) => {
    try {
      const { pool, by, notes } = decideOpts(opts, cmd);
      try {
        const row = await decideProposal(pool, id, "applied", by, notes, new Date());
        if (!row) {
          throw new Error(`предложение ${id.slice(0, 8)}… не найдено или уже решено`);
        }
        console.log(`applied: ${row["field"]} ${row["old_value"]} → ${row["new_value"]} (${by})`);
        console.log("напоминание: внесите правку в config.yaml/harness.md и закоммитьте (change control, harness.md §9)");
      } finally {
        await pool.end();
      }
    } catch (err) {
      fail(err);
    }
  });

metaCmd
  .command("reject <id>")
  .description("решение человека: правка отклонена")
  .option("--by <name>", "кто решил (human:…)")
  .option("--notes <text>", "причина")
  .option("--db <url>", "connection string", DEFAULT_DB_URL)
  .action(async (id: string, opts: Record<string, string | undefined>, cmd: Command) => {
    try {
      const { pool, by, notes } = decideOpts(opts, cmd);
      try {
        const row = await decideProposal(pool, id, "rejected", by, notes, new Date());
        if (!row) {
          throw new Error(`предложение ${id.slice(0, 8)}… не найдено или уже решено`);
        }
        console.log(`rejected: ${row["field"]} ${row["old_value"]} → ${row["new_value"]} (${by})${notes ? ` — ${notes}` : ""}`);
      } finally {
        await pool.end();
      }
    } catch (err) {
      fail(err);
    }
  });

program.addCommand(metaCmd);
program.addCommand(ablationCmd);
program.addCommand(transferCmd);
program.addCommand(auditCmd);
program.addCommand(criticCmd);
program.addCommand(reportCmd);
program.addCommand(decayCmd);
program.addCommand(rollbackCmd);
program.addCommand(canaryCmd);
program.addCommand(scoresCmd);
program.addCommand(retrieveCmd);
program.addCommand(serveCmd);
program.addCommand(migrateCmd);

try {
  await program.parseAsync(process.argv);
} catch (err) {
  fail(err);
}
