import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * Enables portable search extensions and creates the catalog table.
 *
 * Always enabled (native engine):
 * - `pg_trgm` — typo tolerance
 * - `unaccent` — accent-insensitive FTS
 *
 * Lakebase extensions (`lakebase_text`, `lakebase_vector`) are **not** installed
 * here — they require Neon preload libraries and are created at runtime when
 * `engine: "lakebase"` is set (Medusa Cloud).
 */
export class Migration20260807120000 extends Migration {
  override async up(): Promise<void> {
    // Extension creation needs privileges the app role may not have on managed
    // Postgres. The runtime bootstrap degrades gracefully without them, so the
    // migration must not hard-fail either — it only loses typo tolerance /
    // accent folding.
    this.addSql(`
      DO $$
      BEGIN
        BEGIN
          CREATE EXTENSION IF NOT EXISTS pg_trgm;
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'search-postgres: could not enable pg_trgm (%). Typo tolerance will be unavailable.', SQLERRM;
        END;
        BEGIN
          CREATE EXTENSION IF NOT EXISTS unaccent;
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'search-postgres: could not enable unaccent (%). Accent folding will be unavailable.', SQLERRM;
        END;
      END
      $$;
    `)

    this.addSql(`
      create table if not exists "search_postgres_index" (
        "name" text not null,
        "table_name" text not null,
        "schema_hash" text not null,
        "plan" jsonb not null,
        "document_count" integer not null default 0,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        constraint "search_postgres_index_pkey" primary key ("name")
      );
    `)
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "search_postgres_index" cascade;`)
  }
}
