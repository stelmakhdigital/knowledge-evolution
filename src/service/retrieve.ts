import http from "node:http";
import { z } from "zod";
import type { Pool } from "pg";
import { EvolveError } from "../domain/errors.js";
import type { EvolveConfig } from "../config/config.js";
import type { LlmClient } from "../llm/client.js";
import { retrieve } from "../retrieval/search.js";

/**
 * Retrieval-сервис (M2, ТЗ §10): HTTP /retrieve для агента.
 * Единственный путь применения знания — retrieval (ТЗ §10.3): из response
 * агент видит только body элементов (без внутренних score — white-box только
 * в CLI/отчётах, ТЗ §7.2.6).
 */

export const retrieveRequestSchema = z.object({
  query: z.string().min(1),
  agent_id: z.string().min(1),
  task_id: z.string().optional(),
  scope_hints: z.array(z.string()).optional(),
});

export type RetrieveRequestDto = z.infer<typeof retrieveRequestSchema>;

export interface RetrieveServiceOptions {
  readonly pool: Pool;
  readonly config: EvolveConfig;
  readonly llm: LlmClient;
}

/** Формат ответа по профилю агента (ТЗ §14.2): json | markdown | tool_call. */
export type ResponseFormat = "json" | "markdown" | "tool_call";

export function formatResponse(
  result: Awaited<ReturnType<typeof retrieve>>,
  format: ResponseFormat,
  agentProfile: { retrievalTopK?: number; contextBudget?: number } | null,
): unknown {
  const payload = {
    items: result.items.map((r) => ({
      id: r.item.id,
      version: r.item.version,
      title: r.item.title,
      scope: r.item.scope,
      body: r.body,
      channels: r.channels,
    })),
    truncated: result.truncated,
    timed_out: result.timedOut,
    took_ms: result.tookMs,
  };
  if (format === "markdown") {
    const lines = [
      `## Знания (evolve, ${payload.items.length} из top-k=${agentProfile?.retrievalTopK ?? "?"})`,
      "",
      ...payload.items.flatMap((it, i) => [
        `### ${i + 1}. ${it.title} (${it.scope})`,
        "",
        it.body,
        "",
      ]),
    ];
    if (payload.timed_out) {
      lines.push("_(таймаут retrieval — инъекция пропущена, задача не блокируется)_");
    }
    return { ...payload, markdown: lines.join("\n") };
  }
  if (format === "tool_call") {
    return {
      tool: "knowledge",
      arguments: payload,
    };
  }
  return payload;
}

export function createRetrieveServer(opts: RetrieveServiceOptions): http.Server {
  const { pool, config, llm } = opts;

  async function handleRetrieve(req: RequestDto, res: http.ServerResponse): Promise<void> {
    const profile = await pool.query(`SELECT * FROM agent_profiles WHERE agent_id = $1`, [req.agent_id]);
    const profileRow = profile.rows[0];
    const format: ResponseFormat = profileRow ? profileRow["format"] : "json";
    const result = await retrieve(
      pool,
      {
        query: req.query,
        agentId: req.agent_id,
        taskId: req.task_id,
        scopeHints: req.scope_hints,
      },
      config,
      llm,
    );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(formatResponse(result, format, profileRow), null, 2));
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, mode: config.retrieval.mode }));
        return;
      }
      if (req.method === "POST" && req.url === "/retrieve") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const parsed = retrieveRequestSchema.safeParse(raw);
        if (!parsed.success) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: "RETRIEVE_BAD_REQUEST", issues: parsed.error.issues }));
          return;
        }
        await handleRetrieve(parsed.data, res);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "NOT_FOUND" }));
    } catch (err) {
      if (err instanceof EvolveError) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: err.code, message: err.message }));
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "INTERNAL", message: err instanceof Error ? err.message : String(err) }));
    }
  });
  return server;
}

export type RequestDto = RetrieveRequestDto;
