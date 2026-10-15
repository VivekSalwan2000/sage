// Pings every service Sage depends on. Never prints keys.
//   bun run smoke            → Gemini + TinyFish Search/Fetch + Photon connect
//   bun run smoke --agent    → also one TinyFish Agent run (spends a few credits)

import { GoogleGenAI } from "@google/genai";
import { TinyFish, RunStatus } from "@tiny-fish/sdk";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { config } from "../src/config";

const withAgent = process.argv.includes("--agent");
const results: { service: string; ok: boolean; detail: string }[] = [];
const record = (service: string, ok: boolean, detail: string) => {
  results.push({ service, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${service.padEnd(18)} ${detail}`);
};
const time = async <T>(fn: () => Promise<T>) => {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
};
const errMsg = (e: unknown) => ((e as Error)?.message ?? String(e)).slice(0, 200);

// ---------- Gemini ----------
async function gemini() {
  if (!config.geminiKey) return record("Gemini", false, "GEMINI_API_KEY is empty");
  const ai = new GoogleGenAI({ apiKey: config.geminiKey });

  try {
    const flash: string[] = [];
    for await (const m of await ai.models.list()) {
      const name = (m.name ?? "").replace(/^models\//, "");
      if (/flash/i.test(name) && (m.supportedActions ?? []).includes("generateContent")) flash.push(name);
    }
    record("Gemini models", flash.length > 0, `${flash.length} Flash models available: ${flash.slice(0, 12).join(", ")}`);
  } catch (e) {
    record("Gemini models", false, errMsg(e));
  }

  const candidates = [...new Set([config.geminiModel, "gemini-3.8-flash", "gemini-3.5-flash-lite"])];
  for (const model of candidates) {
    try {
      const { value, ms } = await time(() =>
        ai.models.generateContent({
          model,
          contents: 'Reply with JSON {"ok": true}',
          config: { responseMimeType: "application/json", temperature: 0 },
        }),
      );
      const parsed = JSON.parse(value.text ?? "{}");
      record(`Gemini ${model}`, parsed.ok === true, `responded in ${ms} ms`);
    } catch (e) {
      record(`Gemini ${model}`, false, errMsg(e));
    }
  }
}

// ---------- TinyFish ----------
async function tinyfish() {
  if (!config.tinyfishKey) return record("TinyFish", false, "TINYFISH_API_KEY is empty — skipped Search/Fetch/Agent");
  const client = new TinyFish({ apiKey: config.tinyfishKey });

  let firstUrl: string | undefined;
  try {
    const { value, ms } = await time(() =>
      client.search.query({ query: "Canada Post scam text unpaid duty", location: "CA", language: "en" }),
    );
    firstUrl = value.results?.[0]?.url;
    record("TinyFish Search", (value.results?.length ?? 0) > 0, `${value.results?.length ?? 0} results in ${ms} ms`);
  } catch (e) {
    record("TinyFish Search", false, errMsg(e));
  }

  try {
    const url = firstUrl ?? "https://www.canadapost-postescanada.ca/cpc/en/support/kb/general/fraud-scams/fraudulent-communications";
    const { value, ms } = await time(() => client.fetch.getContents({ urls: [url], format: "markdown" }));
    const page = value.results?.[0] as any;
    const chars = typeof page?.text === "string" ? page.text.length : 0;
    record("TinyFish Fetch", chars > 0, `${chars} chars from ${new URL(url).hostname} in ${ms} ms`);
  } catch (e) {
    record("TinyFish Fetch", false, errMsg(e));
  }

  if (!withAgent) return record("TinyFish Agent", true, "skipped (run with --agent to test; uses credits)");
  try {
    const { value, ms } = await time(() =>
      client.agent.run({
        url: "https://www.shopify.com/careers",
        goal: 'Find whether a "Data Analyst" role is listed. Return JSON {"careers_page_url": string, "found": boolean}. If unsure, found=false.',
        browser_profile: "lite",
        agent_config: { max_duration_seconds: 60 },
      } as any),
    );
    const ok = value.status === RunStatus.COMPLETED && !!value.result;
    record("TinyFish Agent", ok, `${value.status} in ${ms} ms → ${JSON.stringify(value.result ?? (value as any).error ?? null).slice(0, 160)}`);
  } catch (e) {
    record("TinyFish Agent", false, errMsg(e));
  }
}

// ---------- Photon Spectrum ----------
async function photon() {
  if (!config.spectrumProjectId || !config.spectrumProjectSecret) {
    return record("Photon Spectrum", false, "SPECTRUM_PROJECT_ID / SECRET empty");
  }
  try {
    const { value: app, ms } = await time(() =>
      Spectrum({
        projectId: config.spectrumProjectId,
        projectSecret: config.spectrumProjectSecret,
        providers: [imessage.config()],
      }),
    );
    record("Photon Spectrum", true, `connected in ${ms} ms`);
    await app.stop();
  } catch (e) {
    record("Photon Spectrum", false, errMsg(e));
  }
}

await gemini();
await tinyfish();
await photon();

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? `✗ ${failed.length} check(s) failed` : "✓ All services responded"}`);
process.exit(failed.length ? 1 : 0);
