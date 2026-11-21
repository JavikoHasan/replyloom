import { createServerFn } from "@tanstack/react-start"
import { withSafeErrors } from "@/lib/errors"
import { readEngineJson } from "@/lib/wa-engine"
import { requireWorkspaceAccess } from "@/lib/auth"

export interface SearchMatch {
  messageId: string
  score: number
  conversationId: string
  waSessionId: string
  text: string
}

// Text search runs against workspace-scoped D1 rows in the engine worker.
export const semanticSearch = createServerFn({ method: "POST" })
  .validator((data: { workspaceId: string; query: string }) => data)
  .handler(
    withSafeErrors(async ({ data }) => {
      if (typeof data.query !== "string" || !data.query.trim()) return []
      // Keep query size bounded so text matching stays inexpensive.
      if (data.query.length > 500) throw new Error("Search query is too long.")

      await requireWorkspaceAccess(data.workspaceId)
      const json = await readEngineJson<{
        ok: boolean
        matches?: SearchMatch[]
        error?: string
      }>("/search", data.workspaceId, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: data.workspaceId,
          query: data.query,
        }),
      })
      if (!json.ok) throw new Error(json.error ?? "Search failed")
      return json.matches ?? []
    }, "Search failed. Please try again.")
  )
