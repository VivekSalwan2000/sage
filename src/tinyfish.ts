// TinyFish = Sage's web layer. Three endpoints, each with a distinct job:
//   Search — find scam reports, fact-checks, and the real organisation's official site
//   Fetch  — read the actual pages (official fraud warnings, news, fact-checks)
//   Agent  — multi-step browsing on the real site: does this job exist? where do I report this?

import { TinyFish, RunStatus } from "@tiny-fish/sdk";
import { config } from "./config";
import { usageGet, usageInc } from "./db";

const client = new TinyFish({ apiKey: config.tinyfishKey });

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  site: string;
  date?: string;
}

export async function search(query: string, opts: { purpose?: string; news?: boolean; includeDomains?: string[] } = {}): Promise<SearchHit[]> {
  try {
    const res = await withTimeout(
      client.search.query({
        query,
        purpose: opts.purpose,
        location: "CA",
        language: "en",
        domain_type: opts.news ? "news" : "web",
        include_domains: opts.includeDomains?.length ? opts.includeDomains.join(",") : undefined,
      }),
      12_000,
      "search",
    );
    return (res.results ?? []).slice(0, 8).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      site: r.site_name,
      date: r.date,
    }));
  } catch (e) {
    console.warn(`[tinyfish.search] "${query}" failed:`, (e as Error).message);
    return [];
  }
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
}

export async function fetchPages(urls: string[], purpose: string): Promise<FetchedPage[]> {
  const unique = [...new Set(urls)].slice(0, 5);
  if (!unique.length) return [];
  try {
    const res = await withTimeout(
      client.fetch.getContents({ urls: unique, purpose, format: "markdown" }),
      60_000,
      "fetch",
    );
    return (res.results ?? [])
      .map((r: any) => ({
        url: r.final_url ?? r.url,
        title: r.title ?? r.url,
        text: typeof r.text === "string" ? r.text : JSON.stringify(r.text ?? ""),
      }))
      .filter((p) => p.text && p.text.length > 80);
  } catch (e) {
    console.warn("[tinyfish.fetch] failed:", (e as Error).message);
    return [];
  }
}

export interface AgentOutcome {
  ok: boolean;
  url: string;
  result: Record<string, unknown> | null;
  note?: string;
}

/** Runs a goal on a real website. Capped per day because it spends credits. */
export async function runAgent(url: string, goal: string, outputSchema?: Record<string, unknown>): Promise<AgentOutcome> {
  if (usageGet("agent_runs") >= config.agentRunsPerDay) {
    return { ok: false, url, result: null, note: "daily agent budget reached" };
  }
  usageInc("agent_runs");
  try {
    const run = await withTimeout(
      client.agent.run({
        url,
        goal,
        browser_profile: "lite",
        agent_config: { max_duration_seconds: 60 }, // custom max_steps needs TinyFish beta access; time cap bounds cost
        ...(outputSchema ? { output_schema: outputSchema } : {}),
      } as any),
      110_000,
      "agent",
    );
    if (run.status !== RunStatus.COMPLETED || !run.result) {
      return { ok: false, url, result: null, note: (run as any).error?.message ?? run.status };
    }
    // COMPLETED doesn't guarantee the goal succeeded — check for block signals.
    const flat = JSON.stringify(run.result).toLowerCase();
    if (/captcha|access denied|blocked by|verify you are human/.test(flat)) {
      return { ok: false, url, result: run.result, note: "site blocked automation" };
    }
    return { ok: true, url, result: run.result };
  } catch (e) {
    console.warn("[tinyfish.agent] failed:", (e as Error).message);
    return { ok: false, url, result: null, note: (e as Error).message };
  }
}
