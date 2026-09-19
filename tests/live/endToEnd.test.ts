// Opt-in: `npm run test:live`. Calls the real TypeSafe API with the key from .env and costs a fraction of a cent.
import { describe, expect, it } from "vitest";
import { createTypeSafe, jevModel, loadEnv } from "../../src/clients.js";
import { documentFromText } from "../../src/pdf/extract.js";
import { DEFAULT_OPTIONS, runPipeline } from "../../src/pipeline.js";
import { loadSchema } from "../../src/schema.js";

describe.skipIf(!process.env.NERJEV_LIVE)("live Jev", () => {
  it("extracts the entities and relations of a known paragraph", async () => {
    loadEnv();
    const text = "Helena Marquez founded Nordlight Robotics in 2014. Nordlight Robotics is headquartered in Oslo.";
    const result = await runPipeline(documentFromText(text, "live"), createTypeSafe(), {
      ...DEFAULT_OPTIONS,
      schema: loadSchema(),
      schemaPath: "schema/default.schema.json",
      model: jevModel(),
      cacheDir: null,
      outDir: null,
      log: () => {},
    });
    const names = result.entities.map((e) => `${e.type}:${e.canonicalName}`);
    expect(names).toEqual(expect.arrayContaining(["person:Helena Marquez", "organization:Nordlight Robotics", "location:Oslo", "date:2014"]));
    const name = (id: string) => result.entities.find((e) => e.id === id)!.canonicalName;
    const relations = result.relations.map((r) => `${name(r.sourceId)} ${r.type} ${name(r.targetId)}`);
    expect(relations).toEqual(expect.arrayContaining(["Helena Marquez founded Nordlight Robotics", "Nordlight Robotics located_in Oslo"]));
    expect(result.calls.every((c) => c.error === null && c.inputTokens! > 0)).toBe(true);
  }, 60_000);
});
