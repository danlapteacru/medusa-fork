import { MedusaError } from "@medusajs/framework/utils"
import { PostgresSearchEngine } from "./plan"

/**
 * Extension bootstrap shared by the migration and the runtime provider.
 *
 * Native engine (default) — portable across self-hosted Postgres and Neon:
 * - Built-in `tsvector` / `tsquery`
 * - `pg_trgm` — typo tolerance
 * - `unaccent` — accent folding
 *
 * Lakebase engine — Neon / Medusa Cloud only (PG16+):
 * - `lakebase_text` — BM25 via `lakebase_bm25`
 * - `lakebase_vector` — ANN via `lakebase_ann` (CASCADE installs `vector`)
 *
 * Avoided: `pg_search` (deprecated on Neon).
 */

export const PG_TRGM_EXTENSION = "pg_trgm"
export const UNACCENT_EXTENSION = "unaccent"
export const LAKEBASE_TEXT_EXTENSION = "lakebase_text"
export const LAKEBASE_VECTOR_EXTENSION = "lakebase_vector"

export function textSearchConfigName(language: string): string {
  return `medusa_search_${language}`
}

export type ExtensionState = {
  engine: PostgresSearchEngine
  pg_trgm: boolean
  /** Schema that owns `pg_trgm` objects, e.g. `"public"`. */
  pg_trgm_schema: string | null
  unaccent: boolean
  /** Text search config to pass to `to_tsvector` / `plainto_tsquery`. */
  text_search_config: string
  lakebase_text: boolean
  lakebase_vector: boolean
}

type DbExecutor = {
  execute: (sql: string, params?: unknown[]) => Promise<any[]>
}

async function extensionSchema(
  manager: DbExecutor,
  name: string
): Promise<string | null> {
  const rows = await manager.execute(
    `SELECT n.nspname AS schema
     FROM pg_extension e
     JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = ?`,
    [name]
  )
  return rows[0]?.schema ? String(rows[0].schema) : null
}

async function tryCreateExtension(
  manager: DbExecutor,
  name: string,
  cascade = false
): Promise<boolean> {
  try {
    const cascadeSql = cascade ? " CASCADE" : ""
    await manager.execute(
      `CREATE EXTENSION IF NOT EXISTS ${name}${cascadeSql}`
    )
  } catch {
    // Role may lack CREATE, or Lakebase may not be preloaded yet.
  }

  return (await extensionSchema(manager, name)) !== null
}

async function ensureUnaccentConfig(
  manager: DbExecutor,
  language: string,
  unaccent: boolean
): Promise<string> {
  if (!unaccent) {
    return language
  }

  const config = textSearchConfigName(language)
  try {
    await manager.execute(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_ts_config WHERE cfgname = '${config}'
        ) THEN
          CREATE TEXT SEARCH CONFIGURATION ${config} (COPY = ${language});
          ALTER TEXT SEARCH CONFIGURATION ${config}
            ALTER MAPPING FOR hword, hword_part, word
            WITH unaccent, ${language}_stem;
        END IF;
      END
      $$;
    `)
    return config
  } catch {
    return language
  }
}

async function ensureCatalog(
  manager: DbExecutor,
  catalogTable: string
): Promise<void> {
  await manager.execute(`
    CREATE TABLE IF NOT EXISTS "${catalogTable}" (
      "name" text NOT NULL,
      "table_name" text NOT NULL,
      "schema_hash" text NOT NULL,
      "plan" jsonb NOT NULL,
      "document_count" integer NOT NULL DEFAULT 0,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "${catalogTable}_pkey" PRIMARY KEY ("name")
    )
  `)
}

/**
 * Ensures the catalog and engine-specific extensions exist.
 */
export async function ensureSearchExtensions(
  manager: DbExecutor,
  options: {
    language: string
    catalogTable: string
    engine?: PostgresSearchEngine
  }
): Promise<ExtensionState> {
  const engine = options.engine ?? "native"

  const pgTrgm = await tryCreateExtension(manager, PG_TRGM_EXTENSION)
  const pgTrgmSchema = pgTrgm
    ? await extensionSchema(manager, PG_TRGM_EXTENSION)
    : null

  const unaccent = await tryCreateExtension(manager, UNACCENT_EXTENSION)
  const textSearchConfig = await ensureUnaccentConfig(
    manager,
    options.language,
    unaccent
  )

  let lakebaseText = false
  let lakebaseVector = false

  if (engine === "lakebase") {
    lakebaseText = await tryCreateExtension(manager, LAKEBASE_TEXT_EXTENSION)
    lakebaseVector = await tryCreateExtension(
      manager,
      LAKEBASE_VECTOR_EXTENSION,
      true
    )

    if (!lakebaseText || !lakebaseVector) {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        `engine: "lakebase" requires the lakebase_text and lakebase_vector extensions (Neon PG16+ with Lakebase Search enabled). ` +
          `Enable the lakebase_text / lakebase_vector preload libraries, restart the compute, then run: ` +
          `CREATE EXTENSION IF NOT EXISTS lakebase_text; CREATE EXTENSION IF NOT EXISTS lakebase_vector CASCADE; ` +
          `Detected: lakebase_text=${lakebaseText}, lakebase_vector=${lakebaseVector}.`
      )
    }
  }

  await ensureCatalog(manager, options.catalogTable)

  return {
    engine,
    pg_trgm: pgTrgm,
    pg_trgm_schema: pgTrgmSchema,
    unaccent,
    text_search_config: textSearchConfig,
    lakebase_text: lakebaseText,
    lakebase_vector: lakebaseVector,
  }
}

/**
 * Schema-qualified `word_similarity(query, text)` for pg_trgm. Unlike plain
 * `similarity`, it compares the query against the best-matching word sequence
 * in the document text, so long documents don't dilute the score.
 */
export function wordSimilarityCall(
  state: Pick<ExtensionState, "pg_trgm_schema">,
  querySql: string,
  textSql: string
): string {
  const schema = state.pg_trgm_schema ?? "public"
  return `"${schema}".word_similarity(${querySql}, ${textSql})`
}
