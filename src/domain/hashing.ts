import { createHash } from "node:crypto";

/** body_hash (ТЗ §7.1): sha256 тела версии, hex. */
export function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}
