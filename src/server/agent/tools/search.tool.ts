/**
 * Web Search Tool using Jina AI
 *
 * Provides web search capability for the agent.
 * Used for real-time data like weather, news, sports scores, etc.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const JINA_API_KEY = process.env.JINA_API_KEY;

export const searchTool = createTool({
  id: "web-search",
  description: "Search the web for current information. Use for real-time data like weather, news, sports scores, business hours, or topics you're unsure about.",
  inputSchema: z.object({
    query: z.string().describe("The search query"),
  }),
  outputSchema: z.object({
    results: z.string().describe("Search results summary"),
  }),
  execute: async (input) => {
    const { query } = input;

    if (!JINA_API_KEY) {
      console.warn("⚠️ JINA_API_KEY not configured");
      return { results: "Web search is not available." };
    }

    console.log(`🔍 Searching web for: "${query}"`);

    try {
      const response = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
        headers: {
          "Authorization": `Bearer ${JINA_API_KEY}`,
          "Accept": "text/plain",
        },
      });

      if (!response.ok) {
        console.error(`❌ Jina API error: ${response.status}`);
        return { results: "Search failed. Please try again." };
      }

      const results = await response.text();

      // Truncate if too long
      const maxLength = 4000;
      const truncated = results.length > maxLength
        ? results.slice(0, maxLength) + "... (truncated)"
        : results;

      console.log(`✅ Search returned ${results.length} characters`);

      return { results: truncated };

    } catch (error) {
      console.error("❌ Search error:", error);
      return { results: "Search failed due to an error." };
    }
  },
});
