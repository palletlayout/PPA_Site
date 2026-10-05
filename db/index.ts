import { neon, type FullQueryResults, type NeonQueryFunction } from "@neondatabase/serverless";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { recordDatabaseBatch } from "../lib/observability.ts";

export type DatabaseValue = string | number | boolean | null | undefined;
export type DatabaseRow = Record<string, unknown>;

export type DatabaseResult<Row extends DatabaseRow = DatabaseRow> = {
  results: Row[];
  success: true;
  meta: { changes: number };
};

function postgresPlaceholders(query: string) {
  let parameter = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let output = "";

  for (let index = 0; index < query.length; index += 1) {
    const character = query[index];
    const next = query[index + 1];

    if (character === "'" && !doubleQuoted) {
      output += character;
      if (singleQuoted && next === "'") {
        output += next;
        index += 1;
      } else {
        singleQuoted = !singleQuoted;
      }
      continue;
    }
    if (character === '"' && !singleQuoted) {
      output += character;
      if (doubleQuoted && next === '"') {
        output += next;
        index += 1;
      } else {
        doubleQuoted = !doubleQuoted;
      }
      continue;
    }
    if (character === "?" && !singleQuoted && !doubleQuoted) {
      parameter += 1;
      output += `$${parameter}`;
      continue;
    }
    output += character;
  }

  return output;
}

export function toPostgresQuery(query: string) {
  return postgresPlaceholders(query).replace(
    /\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/gi,
    "ADD COLUMN IF NOT EXISTS ",
  );
}

function resultFor<Row extends DatabaseRow>(result: FullQueryResults<false>): DatabaseResult<Row> {
  return {
    results: result.rows as Row[],
    success: true,
    meta: { changes: Number(result.rowCount || 0) },
  };
}

function sqliteValue(value: DatabaseValue) {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value ?? null;
}

function sqliteResult<Row extends DatabaseRow>(
  results: Row[] = [],
  changes = 0,
): DatabaseResult<Row> {
  return {
    results,
    success: true,
    meta: { changes },
  };
}

type DatabaseTarget = string | { sqlitePath: string };

export class PreparedStatement {
  private readonly database: Database;
  readonly query: string;
  readonly values: DatabaseValue[];

  constructor(
    database: Database,
    query: string,
    values: DatabaseValue[] = [],
  ) {
    this.database = database;
    this.query = query;
    this.values = values;
  }

  bind(...values: DatabaseValue[]) {
    return new PreparedStatement(this.database, this.query, values);
  }

  async first<Row extends DatabaseRow = DatabaseRow>() {
    const result = await this.database.execute<Row>(this);
    return result.results[0] ?? null;
  }

  all<Row extends DatabaseRow = DatabaseRow>() {
    return this.database.execute<Row>(this);
  }

  run<Row extends DatabaseRow = DatabaseRow>() {
    return this.database.execute<Row>(this);
  }
}

export class DatabaseConflictError extends Error {
  readonly status = 409;
  readonly code = "concurrent_change";

  constructor() {
    super("The demand or scan lease changed before this operation could be saved. Refresh and try again.");
    this.name = "DatabaseConflictError";
  }
}

export class Database {
  readonly dialect: "postgres" | "sqlite";
  private readonly sql: NeonQueryFunction<false, true> | null;
  private readonly sqlite: DatabaseSync | null;

  constructor(target: DatabaseTarget) {
    if (typeof target === "string") {
      this.dialect = "postgres";
      this.sql = neon(target, { fullResults: true });
      this.sqlite = null;
      return;
    }

    this.dialect = "sqlite";
    this.sql = null;
    const sqlitePath = target.sqlitePath === ":memory:"
      ? target.sqlitePath
      : resolve(target.sqlitePath);
    if (sqlitePath !== ":memory:") {
      mkdirSync(dirname(sqlitePath), { recursive: true });
    }
    this.sqlite = new DatabaseSync(sqlitePath);
    this.sqlite.exec(`PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;`);
  }

  prepare(query: string) {
    return new PreparedStatement(this, query);
  }

  queryFor(statement: PreparedStatement) {
    if (!this.sql) {
      throw new Error("Postgres queries are unavailable for a local SQLite database.");
    }
    return this.sql.query(
      toPostgresQuery(statement.query),
      statement.values.map((value) => value ?? null),
    );
  }

  async execute<Row extends DatabaseRow>(statement: PreparedStatement) {
    if (this.sqlite) return this.executeSqlite<Row>(statement);
    if (!/^\s*(?:SELECT|PRAGMA|EXPLAIN)\b/i.test(statement.query)) {
      return (await this.batch([statement]))[0] as DatabaseResult<Row>;
    }
    return resultFor<Row>(await this.queryFor(statement));
  }

  async batch(statements: PreparedStatement[]) {
    const started=performance.now();
    let ok=false;
    try { const result=await this.writeBatch(statements);ok=true;return result; }
    finally {recordDatabaseBatch("write",this.dialect,started,statements.length,ok);}
  }

  private async writeBatch(statements: PreparedStatement[]) {
    if (!statements.length) return [];
    if (this.sqlite) {
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => this.executeSqlite(statement));
        this.sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
    }
    if (!this.sql) throw new Error("The database adapter is unavailable.");
    const results = await this.sql.transaction(
      [
        // Every writer uses the same transaction-scoped lock. This makes the
        // commit-time guards below meaningful across separate server instances.
        this.sql.query("SELECT pg_advisory_xact_lock(1128354388, 1)"),
        ...statements.map((statement) => this.queryFor(statement)),
      ],
      { isolationLevel: "ReadCommitted" },
    );
    return results.slice(1).map((result) => resultFor(result));
  }

  /** One committed snapshot for a complete report, without the writers' lock.
   * All statements must be supplied together: hydration outside this transaction
   * would allow balances and their evidence to describe different commits. */
  async readBatch(statements: PreparedStatement[]) {
    const started=performance.now();
    let ok=false;
    try { const result=await this.readSnapshot(statements);ok=true;return result; }
    finally {recordDatabaseBatch("read",this.dialect,started,statements.length,ok);}
  }

  private async readSnapshot(statements: PreparedStatement[]) {
    if (!statements.length) return [];
    if (statements.some((statement) => !/^\s*(?:SELECT|WITH)\b/i.test(statement.query))) {
      throw new Error("A read snapshot only accepts queries.");
    }
    if (this.sqlite) {
      this.sqlite.exec("PRAGMA query_only = ON; BEGIN");
      try {
        const results = statements.map((statement) => this.executeSqlite(statement));
        this.sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      } finally {
        this.sqlite.exec("PRAGMA query_only = OFF");
      }
    }
    if (!this.sql) throw new Error("The database adapter is unavailable.");
    return (await this.sql.transaction(statements.map((statement) => this.queryFor(statement)), {
      isolationLevel: "RepeatableRead", readOnly: true,
    })).map((result) => resultFor(result));
  }

  async guardedBatch(statements: PreparedStatement[], condition: PreparedStatement) {
    const guardId = crypto.randomUUID();
    try {
      const results = await this.batch([
        this.prepare(`INSERT INTO cartflow_write_guards (id, valid)
          VALUES (?, CASE WHEN (${condition.query}) THEN 1 ELSE 0 END)`)
          .bind(guardId, ...condition.values),
        ...statements,
        this.prepare("DELETE FROM cartflow_write_guards WHERE id = ?").bind(guardId),
      ]);
      return results.slice(1, -1);
    } catch (error) {
      if (error instanceof Error && /cartflow_write_guard_valid/.test(error.message)) {
        throw new DatabaseConflictError();
      }
      throw error;
    }
  }

  close() {
    this.sqlite?.close();
  }

  private executeSqlite<Row extends DatabaseRow>(statement: PreparedStatement) {
    if (!this.sqlite) throw new Error("The local SQLite adapter is unavailable.");
    const prepared = this.sqlite.prepare(statement.query);
    const values = statement.values.map(sqliteValue);
    const returnsRows = /^\s*(?:SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(statement.query)
      || /\bRETURNING\b/i.test(statement.query);
    if (returnsRows) {
      const rows = prepared.all(...values) as Row[];
      const changes = /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(statement.query)
        ? Number((this.sqlite.prepare("SELECT changes() AS count").get() as { count: number }).count)
        : 0;
      return sqliteResult(rows, changes);
    }
    const result = prepared.run(...values);
    return sqliteResult<Row>([], Number(result.changes));
  }
}

let database: Database | null = null;

export function getDatabase() {
  if (database) return database;
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (databaseUrl) {
    database = new Database(databaseUrl);
    return database;
  }
  if (process.env.VERCEL) {
    throw new Error(
      "PPA requires DATABASE_URL when deployed to Vercel. Connect a Neon Postgres database to this project.",
    );
  }

  const configuredPath = process.env.CARTFLOW_DATABASE_PATH?.trim();
  // A missing DATABASE_URL on a production host must not quietly become a SQLite file in
  // the working directory: on an ephemeral or multi-instance host that loses or splits data.
  // Production may use SQLite only when its location is chosen explicitly, or in local mode.
  if (process.env.NODE_ENV === "production" && !configuredPath && process.env.CARTFLOW_AUTH_MODE !== "local") {
    throw new Error(
      "PPA requires DATABASE_URL in production. To use a local SQLite file on a single persistent host, set CARTFLOW_DATABASE_PATH explicitly.",
    );
  }
  const sqlitePath = configuredPath || resolve(process.cwd(), ".cartflow-data", "cartflow.sqlite");
  database = new Database({ sqlitePath });
  return database;
}
