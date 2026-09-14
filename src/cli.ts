#!/usr/bin/env node
/**
 * CLI `evolve` (TЗ §15 M0: item add/list/transition; §7.2.6: white-box show).
 * Единый бинарник: service + CLI (ТЗ §5) — service-часть подключается с M2.
 * M0: LLM — MockLlm (детерминированная); реальный LLM-API — M1 (ТЗ A4).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
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
import { admitCandidate } from "./gates/gates.js";
import { MockLlm } from "./llm/client.js";
import { MemoryStore } from "./store/memory-store.js";
import type { StoreSnapshot } from "./store/store.js";

const SOURCE_TYPES: readonly ProvenanceSourceType[] = ["success", "review", "critic", "human"];

function fail(err: unknown): never {
  if (err instanceof EvolveError || err instanceof ConfigError) {
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
function req(opts: Record<string, string | undefined>, key: string): string {
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

const program = new Command();
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

function openStore(opts: ItemOptions): { store: MemoryStore; statePath: string } {
  loadConfig(opts.config ?? resolveConfigPath()); // валидация конфига на старте
  const statePath = opts.state ?? stateFilePath();
  return { store: loadStore(statePath), statePath };
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
      const { store, statePath } = openStore(globalOpts);
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
      saveStore(store, statePath);

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
  .action((listOpts: { status?: string; type?: string }, cmd: Command) => {
    try {
      const globalOpts = cmd.optsWithGlobals() as ItemOptions;
      const { store } = openStore(globalOpts);
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
      const rows = store.listItems(filter);
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
  .action((id: string, _opts: unknown, cmd: Command) => {
    try {
      const globalOpts = cmd.optsWithGlobals() as ItemOptions;
      const { store } = openStore(globalOpts);
      const itemRow = store.getItem(id);
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
      const prov = store.provenanceFor(itemRow.id);
      console.log(`  provenance (${prov.length}):`);
      for (const p of prov) {
        console.log(`    - source=${p.sourceType} task=${p.taskId} commit=${p.commit} verifier=${String(p.payload["verifier"] ?? "-")} (${p.createdAt})`);
      }
      const versions = store.itemVersions(itemRow.id);
      console.log(`  versions: ${versions.map((v) => `v${v.version}${v.id === versions.at(-1)?.id ? " (current)" : ""}${v.supersededBy ? " (superseded)" : ""}`).join(", ")}`);
      const decisions = store.decisionsFor(itemRow.id);
      console.log(`  decisions (${decisions.length}):`);
      for (const d of decisions) {
        console.log(`    - [${d.createdAt}] ${d.kind} actor=${d.actor} — ${d.reason}`);
      }
      const candidateRef = decisions[0]?.evidence["candidate_ref"];
      if (typeof candidateRef === "string") {
        const gates = store.gateResultsFor(candidateRef);
        if (gates.length > 0) {
          console.log(`  gate_results (${candidateRef}):`);
          for (const g of gates) {
            console.log(`    - [${g.createdAt}] ${g.gate}: ${g.outcome} ${JSON.stringify(g.detail)}`);
          }
        }
      }
      const open = store.listContradictions({ status: "open" }).filter((c) => c.itemAId === itemRow.id || c.itemBId === itemRow.id);
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
      const { store, statePath } = openStore(globalOpts);
      const current = store.getItem(id);
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
      const updated = store.applyTransition(id, {
        to: toStatus,
        kind,
        actor,
        reason: transOpts["reason"] ?? "",
        evidence: { from: current.status },
        ...(toStatus === "archived" ? { archivedReason: transOpts["archivedReason"] ?? "" } : {}),
      });
      saveStore(store, statePath);
      console.log(`${shortId(id)}: ${current.status} → ${updated.status} (kind=${kind}, actor=${actor})`);
    } catch (err) {
      fail(err);
    }
  });

// служебная команда: показать допустимые переходы из статуса
item
  .command("allowed <id>")
  .description("допустимые следующие статусы для item")
  .action((id: string, _opts: unknown, cmd: Command) => {
    try {
      const globalOpts = cmd.optsWithGlobals() as ItemOptions;
      const { store } = openStore(globalOpts);
      const it = store.getItem(id);
      if (!it) {
        throw new EvolveError("NOT_FOUND", `item ${id} не найден`);
      }
      const targets = allowedTargets(it.status);
      console.log(`${shortId(id)} (${it.status}): ${targets.length === 0 ? "терминальный статус" : targets.join(", ")}`);
    } catch (err) {
      fail(err);
    }
  });

program.addCommand(item);

process.on("unhandledRejection", (reason) => {
  console.error("[evolve] unhandledRejection:", reason instanceof Error ? reason.stack ?? reason.message : String(reason));
  process.exit(1);
});

try {
  await program.parseAsync(process.argv);
} catch (err) {
  fail(err);
}
