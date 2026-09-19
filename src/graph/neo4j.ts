import neo4j, { type Driver } from "neo4j-driver";
import type { GraphData } from "../types.js";
import { buildStatements, CONSTRAINTS, type GraphStore, type WriteOptions } from "./store.js";

export interface Neo4jConfig {
  uri: string;
  user: string;
  password: string;
}

export function neo4jConfigFromEnv(): Neo4jConfig {
  return {
    uri: process.env.NEO4J_URI?.trim() || "bolt://localhost:7687",
    user: process.env.NEO4J_USER?.trim() || "neo4j",
    // Matches the default in docker-compose.yml, so a blank NEO4J_PASSWORD works against the local container.
    password: process.env.NEO4J_PASSWORD?.trim() || "nerjev-local",
  };
}

export class Neo4jStore implements GraphStore {
  private readonly driver: Driver;

  constructor(config: Neo4jConfig) {
    // disableLosslessIntegers: counts and offsets come back as JS numbers, not neo4j Integer objects.
    this.driver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password), { disableLosslessIntegers: true });
  }

  async write(data: GraphData, options: WriteOptions): Promise<void> {
    await this.driver.verifyConnectivity();
    const session = this.driver.session();
    try {
      // Schema changes cannot share a transaction with data writes.
      for (const statement of CONSTRAINTS) await session.run(statement.cypher);
      // One transaction per document: a failed load leaves the previous state of the graph intact.
      await session.executeWrite(async (tx) => {
        for (const statement of buildStatements(data, options)) await tx.run(statement.cypher, statement.params);
      });
    } finally {
      await session.close();
    }
  }

  /** Node and relationship counts, for the CLI summary and the idempotency check. */
  async counts(): Promise<{ nodes: number; relationships: number }> {
    const session = this.driver.session();
    try {
      const nodes = await session.run("MATCH (n) RETURN count(n) AS n");
      const relationships = await session.run("MATCH ()-[r]->() RETURN count(r) AS n");
      return { nodes: Number(nodes.records[0]!.get("n")), relationships: Number(relationships.records[0]!.get("n")) };
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}
