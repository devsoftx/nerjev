import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Labels become Choice option names, Neo4j labels and relationship types, so they are restricted. */
const LABEL = /^[a-z][a-z_]*$/;
/** `none` and `not_an_entity` are answer options; the rest would collide with the graph's structural node labels. */
const RESERVED = new Set(["none", "not_an_entity", "entity", "mention", "source_document"]);

const label = z
  .string()
  .regex(LABEL, "labels must match ^[a-z][a-z_]*$")
  .refine((value) => !RESERVED.has(value), "label is reserved");

const SchemaFile = z
  .object({
    entities: z.record(label, z.string().min(1)),
    /** Entity types that merge on exact normalized text only, never through fuzzy pairing. */
    exactMatchOnly: z.array(z.string()).default([]),
    relations: z.record(
      label,
      z.object({
        domain: z.array(z.string()).min(1),
        range: z.array(z.string()).min(1),
        /** Written with the placeholders A (source) and B (target). */
        text: z.string().min(1),
      }),
    ),
  })
  .superRefine((schema, ctx) => {
    const types = new Set(Object.keys(schema.entities));
    if (types.size < 1) ctx.addIssue({ code: "custom", message: "at least one entity type is required" });
    const check = (name: string, where: string) => {
      if (!types.has(name)) ctx.addIssue({ code: "custom", message: `${where}: unknown entity type "${name}"` });
    };
    schema.exactMatchOnly.forEach((name) => check(name, "exactMatchOnly"));
    for (const [relation, def] of Object.entries(schema.relations)) {
      def.domain.forEach((name) => check(name, `relations.${relation}.domain`));
      def.range.forEach((name) => check(name, `relations.${relation}.range`));
    }
  });

export type ExtractionSchema = z.infer<typeof SchemaFile>;

export const DEFAULT_SCHEMA_PATH = fileURLToPath(new URL("../schema/default.schema.json", import.meta.url));

export function parseSchema(raw: unknown): ExtractionSchema {
  return SchemaFile.parse(raw);
}

export function loadSchema(path: string = DEFAULT_SCHEMA_PATH): ExtractionSchema {
  return parseSchema(JSON.parse(readFileSync(path, "utf8")));
}

/** `works_for` -> `WORKS_FOR`. Throws unless the label passes the whitelist pattern. */
export function relationshipType(label: string): string {
  if (!LABEL.test(label)) throw new Error(`unsafe relationship label: ${JSON.stringify(label)}`);
  return label.toUpperCase();
}

/** `organization` -> `Organization`, `geo_feature` -> `GeoFeature`. */
export function nodeLabel(label: string): string {
  if (!LABEL.test(label)) throw new Error(`unsafe node label: ${JSON.stringify(label)}`);
  return label
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
