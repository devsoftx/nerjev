import { nodeLabel, relationshipType } from "../schema.js";
import type { GraphData } from "../types.js";

export interface Statement {
  cypher: string;
  params: Record<string, unknown>;
}

export interface GraphStore {
  write(data: GraphData, options: WriteOptions): Promise<void>;
  close(): Promise<void>;
}

export interface WriteOptions {
  withMentions: boolean;
}

const groupBy = <T>(items: T[], key: (item: T) => string) => {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
};

/**
 * Run before every load, each in its own transaction. The first two migrate graphs written before
 * the source PDF's label changed from :Document to :SourceDocument, which freed :Document for
 * entities of kind "document". A source node is told apart by its sha256 and by not being an :Entity.
 */
export const CONSTRAINTS: Statement[] = [
  { cypher: "DROP CONSTRAINT document_id IF EXISTS", params: {} },
  { cypher: "MATCH (d:Document) WHERE d.sha256 IS NOT NULL AND NOT d:Entity SET d:SourceDocument REMOVE d:Document", params: {} },
  { cypher: "CREATE CONSTRAINT source_document_id IF NOT EXISTS FOR (d:SourceDocument) REQUIRE d.id IS UNIQUE", params: {} },
  { cypher: "CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE", params: {} },
  { cypher: "CREATE CONSTRAINT mention_id IF NOT EXISTS FOR (m:Mention) REQUIRE m.id IS UNIQUE", params: {} },
];

/**
 * The statements that load one document, in order. Cypher cannot take a label or relationship type
 * as a parameter, so those two are interpolated, and only after `nodeLabel` / `relationshipType`
 * have checked them against the schema-label pattern. Everything that comes from a document travels
 * as a parameter. The driver sends every JS number as a float, so integer fields are cast in Cypher.
 */
export function buildStatements(data: GraphData, options: WriteOptions): Statement[] {
  const docId = data.document.id;
  const statements: Statement[] = [
    // Re-ingesting a document replaces what the previous run of that document wrote.
    { cypher: "MATCH (:Entity)-[r]->(:Entity) WHERE r.docId = $docId DELETE r", params: { docId } },
    { cypher: "MATCH (:Entity)-[r:MENTIONED_IN]->(:SourceDocument {id: $docId}) DELETE r", params: { docId } },
    { cypher: "MATCH (m:Mention {docId: $docId}) DETACH DELETE m", params: { docId } },
    { cypher: "MATCH (e:Entity) WHERE NOT (e)--() DELETE e", params: {} },
    {
      cypher:
        "MERGE (d:SourceDocument {id: $doc.id}) " +
        "SET d.sha256 = $doc.sha256, d.path = $doc.path, d.title = $doc.title, d.pageCount = toInteger($doc.pageCount), d.ingestedAt = datetime()",
      params: { doc: data.document },
    },
  ];

  for (const [type, entities] of groupBy(data.entities, (e) => e.type)) {
    statements.push({
      cypher:
        "UNWIND $entities AS e " +
        `MERGE (n:Entity {id: e.id}) SET n:${nodeLabel(type)}, n.type = e.type, n.canonicalName = e.canonicalName, ` +
        "n.aliases = [x IN coalesce(n.aliases, []) WHERE NOT x IN e.aliases] + e.aliases, " +
        "n.confidence = CASE WHEN coalesce(n.confidence, 0.0) > e.confidence THEN n.confidence ELSE e.confidence END " +
        "WITH n, e MATCH (d:SourceDocument {id: $docId}) " +
        "MERGE (n)-[m:MENTIONED_IN]->(d) SET m.count = toInteger(e.count), m.pages = [p IN e.pages | toInteger(p)], m.runId = $runId",
      params: {
        docId,
        runId: data.runId,
        entities: entities.map((e) => ({
          id: e.id,
          type: e.type,
          canonicalName: e.canonicalName,
          aliases: e.aliases,
          confidence: e.confidence,
          count: e.mentionIds.length,
          pages: e.pages,
        })),
      },
    });
  }

  for (const [type, relations] of groupBy(data.relations, (r) => r.type)) {
    statements.push({
      cypher:
        "UNWIND $relations AS r " +
        "MATCH (a:Entity {id: r.sourceId}), (b:Entity {id: r.targetId}) " +
        `MERGE (a)-[x:${relationshipType(type)} {docId: $docId}]->(b) ` +
        "SET x.confidence = r.confidence, x.count = toInteger(r.count), x.evidence = r.evidence, x.pages = [p IN r.pages | toInteger(p)], " +
        "x.chunkIds = r.chunkIds, x.needsReview = r.needsReview, x.model = $model, x.runId = $runId",
      params: {
        docId,
        runId: data.runId,
        model: data.model,
        relations: relations.map((r) => ({
          sourceId: r.sourceId,
          targetId: r.targetId,
          confidence: r.confidence,
          count: r.count,
          evidence: r.evidence.map((e) => e.sentence),
          pages: [...new Set(r.evidence.map((e) => e.page))].sort((a, b) => a - b),
          chunkIds: [...new Set(r.evidence.map((e) => e.chunkId))],
          needsReview: r.needsReview,
        })),
      },
    });
  }

  if (options.withMentions) {
    const entityOf = new Map(data.entities.flatMap((e) => e.mentionIds.map((id) => [id, e.id] as const)));
    statements.push({
      cypher:
        "UNWIND $mentions AS m " +
        "MATCH (e:Entity {id: m.entityId}), (d:SourceDocument {id: $docId}) " +
        "MERGE (n:Mention {id: m.id}) SET n.docId = $docId, n.text = m.text, n.start = toInteger(m.start), n.end = toInteger(m.end), " +
        "n.page = toInteger(m.page), n.confidence = m.confidence " +
        "MERGE (n)-[:REFERS_TO]->(e) MERGE (d)-[:HAS_MENTION]->(n)",
      params: {
        docId,
        mentions: data.mentions
          .filter((m) => entityOf.has(m.id))
          .map((m) => ({
            id: `${docId}:${m.id}`,
            entityId: entityOf.get(m.id),
            text: m.text,
            start: m.start,
            end: m.end,
            page: m.page,
            confidence: m.confidence,
          })),
      },
    });
  }
  return statements;
}
