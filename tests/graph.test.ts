import { describe, expect, it } from "vitest";
import { candidatePairs, jaroWinkler, type NameNode, normalizeName, pairReason } from "../src/entities/block.js";
import { clusterEntities } from "../src/entities/cluster.js";
import { route } from "../src/entities/align.js";
import { cypherLiteral, inlineParams } from "../src/graph/cypherExport.js";
import { buildStatements } from "../src/graph/store.js";
import { aggregateRelations } from "../src/relations/aggregate.js";
import { optionsFor, swapPlaceholders } from "../src/relations/candidates.js";
import { loadSchema, nodeLabel, parseSchema, relationshipType } from "../src/schema.js";
import type { GraphData, Mention } from "../src/types.js";

const schema = loadSchema();

const node = (type: string, name: string): NameNode => ({
  key: `${type}|${normalizeName(name)}`,
  type,
  normalized: normalizeName(name),
  surfaces: new Map([[name, 1]]),
  mentionIds: [`m-${name}`],
  contexts: [],
});

const mention = (name: string, type: string): Mention => ({
  id: `m-${name}`, chunkId: "c0000", sentence: 0, text: name, start: 0, end: name.length, page: 1, type, confidence: 0.9, boundaryP: 0.9, typeP: 1, status: "accepted",
});

describe("entity blocking", () => {
  it("normalizes case, articles, possessives and punctuation", () => {
    expect(normalizeName("The Bank of America's")).toBe("bank of america");
    expect(normalizeName("Hewlett-Packard")).toBe("hewlett packard");
  });

  it("pairs a short form, an acronym and a near spelling, and nothing else", () => {
    expect(pairReason(node("person", "Cook"), node("person", "Tim Cook"))).toBe("subset");
    expect(pairReason(node("organization", "IBM"), node("organization", "International Business Machines"))).toBe("acronym");
    expect(pairReason(node("organization", "Nordlight Robotics"), node("organization", "Nordlite Robotics"))).toBe("similar");
    expect(pairReason(node("organization", "Apple"), node("organization", "Microsoft"))).toBeNull();
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.961, 3);
  });

  it("never pairs across types, and never pairs an exact-match-only type", () => {
    const nodes = [node("person", "Paris"), node("location", "Paris Hilton"), node("date", "March 2021"), node("date", "March 2022")];
    expect(candidatePairs(nodes, schema, 100).pairs).toHaveLength(0);
  });
});

describe("clustering", () => {
  it("merges only 'same' decisions and names the cluster by its most specific form", () => {
    const nodes = [node("person", "Cook"), node("person", "Tim Cook"), node("person", "Tim Cooke")];
    const mentions = nodes.map((n) => mention([...n.surfaces.keys()][0]!, "person"));
    const entities = clusterEntities(
      nodes,
      [
        { a: nodes[0]!.key, b: nodes[1]!.key, type: "person", score: 1.9, confidence: 0.9, outcome: "same" },
        { a: nodes[1]!.key, b: nodes[2]!.key, type: "person", score: 1.1, confidence: 0.4, outcome: "review" },
      ],
      mentions,
    );
    expect(entities.map((e) => e.canonicalName).sort()).toEqual(["Tim Cook", "Tim Cooke"]);
    expect(entities.find((e) => e.canonicalName === "Tim Cook")!.aliases).toEqual(["Cook"]);
  });

  it("does not let a badly bounded form name the entity", () => {
    const nodes = [node("organization", "of the Council of the European Union"), node("organization", "Council of the European Union")];
    // both normalize differently ("of the council..." keeps its "of"), so join them the way Jev would
    const entities = clusterEntities(
      nodes,
      [{ a: nodes[0]!.key, b: nodes[1]!.key, type: "organization", score: 1.98, confidence: 0.9, outcome: "same" }],
      nodes.map((n) => mention([...n.surfaces.keys()][0]!, "organization")),
    );
    expect(entities).toHaveLength(1);
    expect(entities[0]!.canonicalName).toBe("Council of the European Union");
  });

  it("routes a score to the nearest level", () => {
    expect([0.2, 0.5, 1.2, 1.49, 1.5, 2].map(route)).toEqual(["different", "review", "review", "review", "same", "same"]);
  });
});

describe("relation options", () => {
  it("offers a relation in the direction the types allow", () => {
    expect(optionsFor(schema, "person", "organization").map((o) => o.label)).toEqual(["A_works_for_B", "A_founded_B"]);
    expect(optionsFor(schema, "organization", "person").map((o) => o.label)).toEqual(["B_works_for_A", "B_founded_A"]);
    expect(optionsFor(schema, "person", "date")).toEqual([]);
  });

  it("offers both directions between two organizations, with the description reversed", () => {
    const options = optionsFor(schema, "organization", "organization");
    expect(options.map((o) => o.label)).toEqual(["A_acquired_B", "B_acquired_A", "A_subsidiary_of_B", "B_subsidiary_of_A"]);
    expect(options[1]!.text).toBe("B bought or took control of A.");
    expect(swapPlaceholders("A is owned or controlled by B.")).toBe("B is owned or controlled by A.");
  });

  it("merges repeated findings into one edge with all its evidence", () => {
    const instance = (probability: number, sentence: string) => ({ type: "works_for", sourceId: "p", targetId: "o", probability, chunkId: "c0000", sentence, page: 1 });
    const [relation, ...rest] = aggregateRelations([instance(0.6, "one"), instance(0.95, "two")], 0.7);
    expect(rest).toHaveLength(0);
    expect(relation).toMatchObject({ confidence: 0.95, count: 2, needsReview: false });
    expect(relation!.evidence.map((e) => e.sentence)).toEqual(["one", "two"]);
  });
});

describe("cypher safety", () => {
  const graph: GraphData = {
    runId: "run1",
    model: "jev-1.13.0",
    document: { id: "doc1", sha256: "abc", path: "a.pdf", title: 'Quote " and $docId and \\ slash', pageCount: 2 },
    entities: [
      { id: "e1", type: "person", canonicalName: "Robert'); MATCH (n) DETACH DELETE n; //", aliases: [], mentionIds: ["m1"], confidence: 0.9, pages: [1] },
      { id: "e2", type: "organization", canonicalName: "Acme", aliases: ["ACME Corp"], mentionIds: ["m2"], confidence: 0.8, pages: [1, 2] },
    ],
    relations: [{ id: "r1", type: "works_for", sourceId: "e1", targetId: "e2", confidence: 0.9, count: 1, needsReview: false, evidence: [{ chunkId: "c0000", sentence: "He works at Acme.", page: 1, probability: 0.9 }] }],
    mentions: [],
  };

  it("only accepts schema-pattern labels as relationship types and node labels", () => {
    expect(relationshipType("works_for")).toBe("WORKS_FOR");
    expect(nodeLabel("geo_feature")).toBe("GeoFeature");
    for (const bad of ["works-for", "X]->() DELETE", "Works_For", "", "a b"]) {
      expect(() => relationshipType(bad)).toThrow(/unsafe/);
      expect(() => nodeLabel(bad)).toThrow(/unsafe/);
    }
    expect(() => buildStatements({ ...graph, relations: [{ ...graph.relations[0]!, type: "x`]->() DETACH DELETE" }] }, { withMentions: false })).toThrow(/unsafe/);
  });

  it("rejects a schema file whose labels would be unsafe or reserved", () => {
    const base = { entities: { person: "p" }, relations: {} };
    expect(() => parseSchema({ ...base, entities: { "Per son": "p" } })).toThrow();
    expect(() => parseSchema({ ...base, entities: { none: "p" } })).toThrow();
    expect(() => parseSchema({ ...base, relations: { knows: { domain: ["alien"], range: ["person"], text: "A knows B." } } })).toThrow(/unknown entity type/);
  });

  it("keeps document text out of the query string", () => {
    for (const statement of buildStatements(graph, { withMentions: true })) {
      expect(statement.cypher).not.toContain("Robert");
      expect(statement.cypher).not.toContain("Acme");
      expect(statement.cypher).not.toContain("Quote");
    }
  });

  it("escapes values when it inlines them for the .cypher export", () => {
    expect(cypherLiteral('a "quoted" \\ value\n')).toBe('"a \\"quoted\\" \\\\ value\\n"');
    expect(cypherLiteral([1, "x", true, null])).toBe('[1, "x", true, null]');
    expect(() => cypherLiteral({ "bad key": 1 })).toThrow(/unsafe map key/);
    const inlined = inlineParams({ cypher: "MERGE (d:Document {id: $doc.id}) SET d.title = $doc.title", params: { doc: graph.document } });
    // a "$docId" inside a value is data, and must not be substituted a second time
    expect(inlined).toContain('title: "Quote \\" and $docId and \\\\ slash"');
    expect(() => inlineParams({ cypher: "RETURN $missing", params: {} })).toThrow(/missing parameter/);
  });
});
