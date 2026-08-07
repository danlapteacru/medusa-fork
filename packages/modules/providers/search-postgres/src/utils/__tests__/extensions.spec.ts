import {
  ensureSearchExtensions,
  textSearchConfigName,
  wordSimilarityCall,
} from "../extensions"

describe("search extensions helpers", () => {
  it("builds the medusa text search config name", () => {
    expect(textSearchConfigName("english")).toBe("medusa_search_english")
  })

  it("schema-qualifies word_similarity()", () => {
    expect(
      wordSimilarityCall(
        {
          pg_trgm_schema: "public",
        },
        "?",
        `"search_text"`
      )
    ).toBe(`"public".word_similarity(?, "search_text")`)
  })

  it("enables portable extensions and creates the catalog", async () => {
    const created: string[] = []
    const manager = {
      execute: async (sql: string, params: unknown[] = []) => {
        const normalized = sql.replace(/\s+/g, " ").trim()

        if (normalized.startsWith("CREATE EXTENSION")) {
          const match = normalized.match(
            /CREATE EXTENSION IF NOT EXISTS ([a-z0-9_]+)/i
          )
          if (match) {
            created.push(match[1])
          }
          return []
        }

        if (normalized.includes("FROM pg_extension")) {
          return created.includes(params[0] as string)
            ? [{ schema: "public" }]
            : []
        }

        if (normalized.startsWith("DO $$") || normalized.includes("CREATE TABLE")) {
          return []
        }

        return []
      },
    }

    const state = await ensureSearchExtensions(manager, {
      language: "english",
      catalogTable: "search_postgres_index",
      engine: "native",
    })

    expect(created).toEqual(expect.arrayContaining(["pg_trgm", "unaccent"]))
    expect(created).not.toEqual(
      expect.arrayContaining(["lakebase_text", "lakebase_vector"])
    )
    expect(state.pg_trgm).toBe(true)
    expect(state.engine).toBe("native")
    expect(state.lakebase_text).toBe(false)
    expect(state.text_search_config).toBe("medusa_search_english")
  })

  it("requires lakebase extensions when engine is lakebase", async () => {
    const manager = {
      execute: async (sql: string, params: unknown[] = []) => {
        const normalized = sql.replace(/\s+/g, " ").trim()

        if (normalized.startsWith("CREATE EXTENSION")) {
          return []
        }

        if (normalized.includes("FROM pg_extension")) {
          // Simulate native extensions present, lakebase missing.
          const name = params[0] as string
          if (name === "pg_trgm" || name === "unaccent") {
            return [{ schema: "public" }]
          }
          return []
        }

        if (normalized.includes("CREATE TABLE")) {
          return []
        }

        return []
      },
    }

    await expect(
      ensureSearchExtensions(manager, {
        language: "english",
        catalogTable: "search_postgres_index",
        engine: "lakebase",
      })
    ).rejects.toThrow(/lakebase_text and lakebase_vector/)
  })

  it("enables lakebase extensions when available", async () => {
    const created: string[] = []
    const manager = {
      execute: async (sql: string, params: unknown[] = []) => {
        const normalized = sql.replace(/\s+/g, " ").trim()

        if (normalized.startsWith("CREATE EXTENSION")) {
          const match = normalized.match(
            /CREATE EXTENSION IF NOT EXISTS ([a-z0-9_]+)/i
          )
          if (match) {
            created.push(match[1])
          }
          return []
        }

        if (normalized.includes("FROM pg_extension")) {
          return created.includes(params[0] as string)
            ? [{ schema: "public" }]
            : []
        }

        if (normalized.startsWith("DO $$") || normalized.includes("CREATE TABLE")) {
          return []
        }

        return []
      },
    }

    const state = await ensureSearchExtensions(manager, {
      language: "english",
      catalogTable: "search_postgres_index",
      engine: "lakebase",
    })

    expect(created).toEqual(
      expect.arrayContaining([
        "pg_trgm",
        "unaccent",
        "lakebase_text",
        "lakebase_vector",
      ])
    )
    expect(state.engine).toBe("lakebase")
    expect(state.lakebase_text).toBe(true)
    expect(state.lakebase_vector).toBe(true)
  })

  it("degrades when extensions cannot be created", async () => {
    const manager = {
      execute: async (sql: string) => {
        if (sql.includes("CREATE EXTENSION")) {
          throw new Error("permission denied")
        }
        if (sql.includes("FROM pg_extension")) {
          return []
        }
        if (sql.includes("CREATE TABLE")) {
          return []
        }
        return []
      },
    }

    const state = await ensureSearchExtensions(manager, {
      language: "english",
      catalogTable: "search_postgres_index",
      engine: "native",
    })

    expect(state.pg_trgm).toBe(false)
    expect(state.unaccent).toBe(false)
    expect(state.text_search_config).toBe("english")
  })
})
