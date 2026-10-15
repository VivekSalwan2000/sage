// The multi-step web investigation. Search → Fetch → Agent, then a sourced verdict.

import { parse } from "tldts";
import { search, fetchPages, runAgent, type SearchHit } from "./tinyfish";
import { judge, damageControl, type Judgement, type Source, type Understanding } from "./brain";
import { cacheGet, cacheSet } from "./db";
import { config } from "./config";

type Check = NonNullable<Understanding["check"]>;
export type Progress = (line: string) => Promise<void> | void;

export interface Investigation {
  judgement: Judgement;
  sources: Source[]; // only the ones actually cited, in order
  checkedCount: number;
  fromCache: boolean;
}

const SOCIAL = /(facebook|instagram|twitter|x\.com|linkedin|reddit|youtube|tiktok|wikipedia|quora|pinterest)\./i;

const regDomain = (u: string) => {
  const p = parse(u.includes("://") ? u : `https://${u}`);
  return p.domain ?? p.hostname ?? null;
};

function hashKey(check: Check): string {
  const basis = [check.type, check.claimed_sender, check.key_phrase, check.claim, (check.links ?? []).map(regDomain).join(",")]
    .filter(Boolean)
    .join("|")
    .toLowerCase()
    .replace(/\s+/g, " ");
  return `inv:${Bun.hash(basis).toString(36)}`;
}

function excerpt(text: string, max = 1400): string {
  return text.replace(/\n{3,}/g, "\n\n").slice(0, max);
}

/** Pick the organisation's official domain from search results, preferring the model's guess if confirmed. */
function pickOfficial(hits: SearchHit[], guess?: string | null): string | null {
  const g = guess ? regDomain(guess) : null;
  if (g && hits.some((h) => regDomain(h.url) === g)) return g;
  const first = hits.find((h) => !SOCIAL.test(h.url));
  return first ? regDomain(first.url) : g;
}

export async function investigate(check: Check, language: string, progress: Progress): Promise<Investigation> {
  const key = hashKey(check);
  const cached = cacheGet<Investigation>(key, config.cacheHours);
  if (cached) {
    await progress("⚡ I've checked this one recently — pulling up what I found…");
    return { ...cached, fromCache: true };
  }

  const sources: Source[] = [];
  const add = (s: Omit<Source, "id">) => {
    if (sources.some((x) => x.url === s.url)) return;
    sources.push({ ...s, id: sources.length + 1 });
  };
  const notes: string[] = [];
  let linkCheck = "No links in the message.";

  if (check.type === "scam") {
    const sender = check.claimed_sender?.trim() || "";
    const phrase = check.key_phrase?.trim() || check.summary;

    // ── Step 1: SEARCH (parallel): scam reports + the real organisation's official site
    await progress(`🔎 Searching for reports of this message${sender ? ` and ${sender}'s official site` : ""}…`);
    const [reports, official] = await Promise.all([
      search(`${sender ? sender + " " : ""}"${phrase.slice(0, 80)}" scam`, { purpose: "Find reports that this exact message is a known scam" }),
      sender ? search(`${sender} official website`, { purpose: "Identify the organisation's real official domain" }) : Promise.resolve([] as SearchHit[]),
    ]);
    const officialDomain = pickOfficial(official, check.official_domain_guess);

    // Link check: does the link actually belong to who it claims to be from?
    const linkDomains = [...new Set((check.links ?? []).map(regDomain).filter(Boolean) as string[])];
    if (linkDomains.length) {
      if (officialDomain) {
        const mismatched = linkDomains.filter((d) => d !== officialDomain);
        linkCheck = mismatched.length
          ? `Link domain(s) ${mismatched.join(", ")} do NOT match ${sender || "the sender"}'s official domain ${officialDomain}.`
          : `Link domain(s) match the official domain ${officialDomain}.`;
      } else {
        linkCheck = `Link domain(s): ${linkDomains.join(", ")}. Official domain could not be confirmed.`;
      }
    }

    // Fraud-warning page on the official site
    const fraudHits = officialDomain
      ? await search(`${sender || officialDomain} fraud scam phishing warning`, {
          includeDomains: [officialDomain],
          purpose: "Find the organisation's own page about scams and how to report them",
        })
      : [];

    // ── Step 2: FETCH: read the official warning page + top scam reports
    const toRead = [
      ...fraudHits.slice(0, 1).map((h) => h.url),
      ...(fraudHits.length ? [] : officialDomain ? [`https://${officialDomain}`] : []),
      ...reports.filter((h) => !SOCIAL.test(h.url)).slice(0, 2).map((h) => h.url),
    ];
    await progress(`📄 Reading ${officialDomain ? officialDomain + " and " : ""}${toRead.length} live page${toRead.length === 1 ? "" : "s"}…`);

    // ── Step 3: AGENT (in parallel with Fetch): act on the real site
    const agentTask = (() => {
      if (check.job?.company) {
        const careersBase = officialDomain ? `https://${officialDomain}` : `https://www.google.com/search?q=${encodeURIComponent(check.job.company + " careers")}`;
        return runAgent(
          careersBase,
          `Go to ${check.job.company}'s official careers/jobs page. Search for a posting matching "${check.job.role}". ` +
            `Return JSON: {"careers_page_url": string|null, "role_found": boolean, "closest_matching_title": string|null, ` +
            `"posting_url": string|null, "official_hiring_warning": string|null}. ` +
            `official_hiring_warning = any text on their site warning about fake recruiters or recruitment scams, quoted briefly. If not found, use null.`,
        );
      }
      if (officialDomain) {
        return runAgent(
          `https://${officialDomain}`,
          `On this official website, find (1) how to report phishing or fraud and (2) the official customer support phone number or contact page. ` +
            `Navigate through Help/Contact/Security pages if needed. Return JSON: {"report_method": string|null, "report_page_url": string|null, ` +
            `"official_phone": string|null, "contact_page_url": string|null}. Only include values you actually saw on the site.`,
        );
      }
      return Promise.resolve(null);
    })();
    if (check.job?.company) await progress(`🧭 Checking ${check.job.company}'s real careers page for this role…`);
    else if (officialDomain) await progress(`🧭 Finding ${officialDomain}'s official way to report this…`);

    const [pages, agent] = await Promise.all([fetchPages(toRead, "Verify whether a message is a scam and how to report it"), agentTask]);

    for (const p of pages) {
      const isOfficial = officialDomain && regDomain(p.url) === officialDomain;
      add({ title: p.title, url: p.url, excerpt: excerpt(p.text), kind: isOfficial ? "official" : "report" });
    }
    if (agent?.ok && agent.result) {
      const r = agent.result as Record<string, unknown>;
      const url = (r.posting_url || r.careers_page_url || r.report_page_url || r.contact_page_url || agent.url) as string;
      add({ title: `${officialDomain ?? check.job?.company} (checked live by Sage)`, url, excerpt: JSON.stringify(r), kind: "agent" });
    } else if (agent && !agent.ok) {
      notes.push(`Live site check could not complete (${agent.note}). Do not claim anything from it.`);
    }
    // Search snippets as weaker supporting evidence
    for (const h of reports.slice(0, 3)) add({ title: h.title, url: h.url, excerpt: h.snippet, kind: "search" });
  } else {
    // ── Fact-check path: SEARCH news + fact-checks → FETCH the best ones
    const claim = check.claim?.trim() || check.summary;
    await progress("🔎 Searching news and fact-checkers…");
    const [news, factchecks] = await Promise.all([
      search(claim.slice(0, 200), { news: true, purpose: "Find credible news coverage of this claim" }),
      search(`${claim.slice(0, 160)} fact check`, { purpose: "Find fact-checks of this claim" }),
    ]);
    const best = [...factchecks.slice(0, 2), ...news.slice(0, 2)].filter((h) => !SOCIAL.test(h.url));
    await progress(`📄 Reading ${best.length} source${best.length === 1 ? "" : "s"}…`);
    const pages = await fetchPages(best.map((h) => h.url), "Fact-check a claim forwarded on social media");
    for (const p of pages) add({ title: p.title, url: p.url, excerpt: excerpt(p.text), kind: "news" });
    for (const h of [...factchecks, ...news].slice(0, 4)) add({ title: h.title, url: h.url, excerpt: h.snippet, kind: "search" });
  }

  await progress("🧠 Weighing the evidence…");
  const judgement = await judge({ language, check, linkCheck, sources, extraNotes: notes });

  // Never fake a source: keep only citations that point at real fetched/searched items.
  const valid = new Set(sources.map((s) => s.id));
  judgement.why = (judgement.why ?? []).map((w) => ({ ...w, source_ids: (w.source_ids ?? []).filter((id) => valid.has(id)) }));
  const cited = [...new Set(judgement.why.flatMap((w) => w.source_ids))];
  const citedSources = cited.map((id) => sources.find((s) => s.id === id)!).filter(Boolean);
  if (judgement.official_contact && !sources.some((s) => (s.kind === "official" || s.kind === "agent") && s.excerpt.includes(judgement.official_contact!.replace(/[^\d]/g, "").slice(-7)))) {
    judgement.official_contact = null; // contact must be traceable to the official site
  }

  const result: Investigation = { judgement, sources: citedSources, checkedCount: sources.length, fromCache: false };
  if (sources.length) cacheSet(key, result);
  return result;
}

/** "I already clicked" — find the real org's guidance and give calm next steps. */
export async function recover(about: string, sender: string | null, language: string) {
  const hits = await search(`${sender ?? ""} what to do if you clicked a phishing link scam Canada`.trim(), {
    purpose: "Find official guidance for someone who already responded to a scam",
  });
  const pages = await fetchPages(hits.filter((h) => !SOCIAL.test(h.url)).slice(0, 2).map((h) => h.url), "Steps after falling for a scam");
  const sources: Source[] = pages.map((p, i) => ({ id: i + 1, title: p.title, url: p.url, excerpt: excerpt(p.text, 1200), kind: "official" }));
  const plan = await damageControl(language, about, sources);
  const valid = new Set(sources.map((s) => s.id));
  return { plan, sources: sources.filter((s) => (plan.source_ids ?? []).filter((id) => valid.has(id)).includes(s.id)) };
}
