import { writeFileSync } from "node:fs";
import type { GraphData } from "../types.js";
import { buildStatements, CONSTRAINTS, type GraphStore, type Statement, type WriteOptions } from "./store.js";

/** A value as a Cypher literal. JSON string escapes are a subset of Cypher's, so strings reuse them. */
export function cypherLiteral(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(cypherLiteral).join(", ")}]`;
  if (typeof value === "object") {
    const fields = Object.entries(value).map(([key, inner]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`unsafe map key: ${JSON.stringify(key)}`);
      return `${key}: ${cypherLiteral(inner)}`;
    });
    return `{${fields.join(", ")}}`;
  }
  throw new Error(`cannot render ${typeof value} as a Cypher literal`);
}

/** Replaces each `$name` with its literal, so the script runs in cypher-shell with no parameters set. */
export function inlineParams(statement: Statement): string {
  return statement.cypher.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
    if (!(name in statement.params)) throw new Error(`missing parameter $${name}`);
    return cypherLiteral(statement.params[name]);
  });
}

/** Writes the load as a .cypher script, so the pipeline runs end to end without a database. */
export class CypherExportStore implements GraphStore {
  constructor(private readonly path: string) {}

  async write(data: GraphData, options: WriteOptions): Promise<void> {
    const lines = [...CONSTRAINTS, ...buildStatements(data, options)].map((s) => `${inlineParams(s)};`);
    writeFileSync(this.path, `// nerjev run ${data.runId}, document ${data.document.id}\n${lines.join("\n")}\n`);
  }

  async close(): Promise<void> {}
}
