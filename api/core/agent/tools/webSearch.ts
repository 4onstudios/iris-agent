import { z } from "zod";
import BrowserManager from "../../library/BrowserManager";

type SearchEngine = "duckduckgo" | "bing";

type SearchResult = {
  title: string;
  url: string;
};

type SearchWebParams = {
  query: string;
  engine?: SearchEngine;
  maxResults?: number;
};

type SearchWebResult =
  | {
      success: true;
      results: SearchResult[];
    }
  | {
      success: false;
      error: string;
    };

/**
 * Web search tool using a search API
 * @param {Object} params
 * @param {string} params.query - Search query
 * @param {number} [params.maxResults=5] - Max results to return
 * @returns {Promise<Object>} Search results
 */

// Engine-specific selectors that target actual search result links,
// avoiding nav/footer/ad anchors returned by a broad querySelectorAll("a").
const RESULT_SELECTORS: Record<SearchEngine, string> = {
  duckduckgo: "[data-testid='result-title-a']",
  bing: ".b_algo h2 a",
};

async function webSearch(
  query: string,
  engine: SearchEngine = "duckduckgo",
  maxResults = 5,
): Promise<SearchResult[]> {
  if (!query) {
    throw new Error("Search query is required");
  }

  const browserManager = await BrowserManager.getInstance();
  const page = await browserManager.newPage();

  try {
    const url =
      engine === "duckduckgo"
        ? `https://duckduckgo.com/?q=${encodeURIComponent(query)}`
        : `https://bing.com/search?q=${encodeURIComponent(query)}`;

    // "domcontentloaded" is sufficient for scraping rendered HTML and is
    // significantly faster than "networkidle2".
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });

    const selector = RESULT_SELECTORS[engine] ?? RESULT_SELECTORS.duckduckgo;

    const results = await page.evaluate(
      (resultSelector: string, limit: number) => {
        return Array.from(document.querySelectorAll<HTMLAnchorElement>(resultSelector))
          .slice(0, limit)
          .map((a) => ({
            title: a.textContent?.trim() ?? "",
            url: a.href,
          }));
      },
      selector,
      maxResults,
    );

    return results;
  } finally {
    await page.close();
  }
}

//this is the function that out webSearchTool will be calling
export async function searchWeb({
  query,
  engine,
  maxResults = 5,
}: SearchWebParams): Promise<SearchWebResult> {
  try {
    //performs web search and returns results, if failed it returns error
    const results = await webSearch(query, engine, maxResults);

    return {
      success: true,
      results,
    };
  } catch (error) {
    const err = error as Error;
    return {
      success: false,
      error: err.message,
    };
  }
}

export const webSearchTool = {
  description: "Search the web for real-time information",
  parameters: z.object({
    query: z.string().describe("The search query to look up on the web"),
    engine: z
      .enum(["duckduckgo", "bing"])
      .default("duckduckgo")
      .describe("Search engine to use"),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("Maximum number of results to return"),
  }),
  execute: searchWeb,
};

export default webSearchTool;
