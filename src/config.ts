// Central config. Every secret comes from the environment (.env) — never commit keys.

function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  mode: (process.env.SAGE_MODE ?? "imessage") as "imessage" | "terminal",
  botName: process.env.SAGE_NAME ?? "Sage",

  spectrumProjectId: process.env.SPECTRUM_PROJECT_ID ?? "",
  spectrumProjectSecret: process.env.SPECTRUM_PROJECT_SECRET ?? "",

  tinyfishKey: process.env.TINYFISH_API_KEY ?? "",
  geminiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite", // 3.8 Flash free-tier quota is too small (429/504 in testing)
  geminiFallbackModel: process.env.GEMINI_FALLBACK_MODEL ?? "gemini-3.1-flash-lite", // separate quota pool, used on retries
  // Verdict model. 3.6/3.8 Flash judged better in principle but were overloaded (503/504) in testing, so default to Flash-Lite.
  geminiJudgeModel: process.env.GEMINI_JUDGE_MODEL ?? process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite",
  geminiTimeoutMs: num("GEMINI_TIMEOUT_MS", 20_000),

  dbPath: process.env.SAGE_DB ?? "sage.db",

  // Limits — this runs on free tiers and a small credit budget.
  checksPerUserPerDay: num("CHECKS_PER_USER_PER_DAY", 8),
  agentRunsPerDay: num("AGENT_RUNS_PER_DAY", 40), // global cap on credit-using Agent runs
  cacheHours: num("CACHE_HOURS", 24),

  // Demo mode: if set, only these numbers get answers (E.164, comma-separated).
  allowlist: list("ALLOWLIST"),

  // How long to wait for more messages in a burst ("describe it" + screenshot) before acting.
  debounceMs: num("DEBOUNCE_MS", 3500),
};

export function assertConfig() {
  const missing: string[] = [];
  if (!config.tinyfishKey) missing.push("TINYFISH_API_KEY");
  if (!config.geminiKey) missing.push("GEMINI_API_KEY");
  if (config.mode === "imessage") {
    if (!config.spectrumProjectId) missing.push("SPECTRUM_PROJECT_ID");
    if (!config.spectrumProjectSecret) missing.push("SPECTRUM_PROJECT_SECRET");
  }
  if (missing.length) {
    console.error(`\n✗ Missing environment variables: ${missing.join(", ")}\n  Copy .env.example to .env and fill them in.\n`);
    process.exit(1);
  }
}
