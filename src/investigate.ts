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
  /** One page worth opening (shown as a website preview card): the official page if we have one. */
  preview?: string;
  /** Who the message claims to be from, for labels like "📞 Canada Post: …". */
  org?: string;
  /** Every page that was searched/read, for when the verdict cites none (so "links" is never empty). */
  checked?: string[];
}

const SOCIAL = /(facebook|instagram|twitter|x\.com|linkedin|reddit|youtube|tiktok|wikipedia|quora|pinterest)\./i;

// Well-known platforms that real businesses send links through (bookings, payments, e-signatures, tickets).
// A link here is not a domain "mismatch" on its own — in live testing a real salon's Square booking text was
// flagged SUSPICIOUS for exactly that. Scammers can abuse these too, so the judge still weighs other red flags.
const PLATFORMS: Record<string, string> = {
  "squareup.com": "Square (bookings/payments)", "square.site": "Square (online stores)", "square.link": "Square (payment links)",
  "calendly.com": "Calendly (scheduling)", "booksy.com": "Booksy (salon bookings)", "vagaro.com": "Vagaro (salon bookings)",
  "fresha.com": "Fresha (salon bookings)", "janeapp.com": "Jane (clinic bookings)", "acuityscheduling.com": "Acuity (scheduling)",
  "setmore.com": "Setmore (scheduling)", "mindbodyonline.com": "Mindbody (fitness bookings)", "opentable.com": "OpenTable (restaurants)",
  "opentable.ca": "OpenTable (restaurants)", "resy.com": "Resy (restaurants)", "eventbrite.com": "Eventbrite (tickets)",
  "eventbrite.ca": "Eventbrite (tickets)", "ticketmaster.com": "Ticketmaster (tickets)", "ticketmaster.ca": "Ticketmaster (tickets)",
  "stripe.com": "Stripe (payments)", "paypal.com": "PayPal (payments)", "interac.ca": "Interac (e-Transfer)",
  "myshopify.com": "Shopify (online stores)", "docusign.net": "DocuSign (e-signatures)", "docusign.com": "DocuSign (e-signatures)",
  "zoom.us": "Zoom (meetings)", "wealthsimple.com": "Wealthsimple", "uber.com": "Uber", "doordash.com": "DoorDash",
};
const SHORTENERS = /^(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|rebrand\.ly|cutt\.ly|shorturl\.at|rb\.gy)$/i;

const regDomain = (u: string) => {
  const p = parse(u.includes("://") ? u : `https://${u}`);
  return p.domain ?? p.hostname ?? null;
};

// Language is part of the key: a cached verdict is written in the language it was first asked in.
function hashKey(check: Check, language: string): string {
  const basis = [language, check.type, check.claimed_sender, check.key_phrase, check.claim, (check.links ?? []).map(regDomain).join(",")]
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

/** An official phone/email/URL counts only if it appears in an official-site or agent-visited source. */
function contactIsTraceable(contact: string, sources: Source[]): boolean {
  const trusted = sources.filter((s) => s.kind === "official" || s.kind === "agent");
  const digits = contact.replace(/\D/g, "");
  if (digits.length >= 7) {
    // Phone number: compare digits only, so "1-866-607-6301" matches "(866) 607 6301".
    const tail = digits.slice(-10);
    return trusted.some((s) => s.excerpt.replace(/\D/g, "").includes(tail));
  }
  // Email / URL / anything else: must appear verbatim (case-insensitive). Empty never matches.
  const needle = contact.trim().toLowerCase();
  return needle.length > 3 && trusted.some((s) => s.excerpt.toLowerCase().includes(needle));
}

export async function investigate(check: Check, language: string, progress: Progress): Promise<Investigation> {
  const key = hashKey(check, language);
  const cached = cacheGet<Investigation>(key, config.cacheHours);
  if (cached) {
    await progress("⚡ I checked this one recently…");
    return { ...cached, fromCache: true };
  }

  const sources: Source[] = [];
  const add = (s: Omit<Source, "id">) => {
    const norm = (u: string) => u.replace(/[?#].*$/, "").replace(/\/$/, "");
    const dup = sources.find((x) => norm(x.url) === norm(s.url)); // same page, maybe with different tracking params
    if (dup) {
      // The agent often starts on a page Fetch already read; keep its findings by merging them in (live testing lost them).
      if (s.kind === "agent") dup.excerpt = `${s.excerpt}\n\n${dup.excerpt}`.slice(0, 2000);
      return;
    }
    sources.push({ ...s, id: sources.length + 1 });
  };
  const notes: string[] = [];
  let linkCheck = "No links in the message.";
  let officialSite: string | null = null; // the organisation's confirmed website, for the preview card
  let linkMismatch = false; // set only by the code's own link check — the judge can't claim it otherwise
  let roleMissing = false; // set only when the agent really searched the careers page and found nothing

  if (check.type === "scam") {
    const sender = check.claimed_sender?.trim() || "";
    const phrase = check.key_phrase?.trim() || check.summary;

    const linkDomains = [...new Set((check.links ?? []).map(regDomain).filter(Boolean) as string[])];

    // ── Step 1: SEARCH (parallel): scam reports (by wording, and by the link's domain) + the real organisation's official site.
    // No exact-phrase quotes: scam texts get reworded, and quoted queries mostly return nothing.
    await progress("🔎 Looking into this for you…");
    const [byWording, byLink, official] = await Promise.all([
      search(`${sender ? sender + " " : ""}${phrase.slice(0, 100)} scam text`, { purpose: "Find reports that this message is a known scam" }),
      linkDomains.length ? search(`${linkDomains[0]} scam`, { purpose: "Find reports about this suspicious website" }) : Promise.resolve([] as SearchHit[]),
      sender ? search(`${sender} official website`, { purpose: "Identify the organisation's real official domain" }) : Promise.resolve([] as SearchHit[]),
    ]);
    const officialDomain = pickOfficial(official, check.official_domain_guess);
    // Third-party reports only (the official site is read separately); interleave both searches, dedupe.
    const reports: SearchHit[] = [];
    for (let i = 0; i < 8; i++) {
      for (const h of [byLink[i], byWording[i]]) {
        if (h && !SOCIAL.test(h.url) && regDomain(h.url) !== officialDomain && !reports.some((r) => r.url === h.url)) reports.push(h);
      }
    }

    // Link check: does the link actually belong to who it claims to be from?
    if (linkDomains.length) {
      const facts: string[] = [];
      for (const d of linkDomains) {
        if (officialDomain && d === officialDomain) facts.push(`${d} matches ${sender || "the sender"}'s official domain.`);
        else if (PLATFORMS[d]) facts.push(`${d} is ${PLATFORMS[d]}, a well-known platform real businesses use to send these links — NOT a mismatch by itself; judge by the other red flags.`);
        else if (SHORTENERS.test(d) && (linkMismatch = true)) facts.push(`${d} is a URL shortener that hides the real destination — a red flag in an unexpected message.`);
        else if (officialDomain && (linkMismatch = true)) facts.push(`${d} does NOT match ${sender || "the sender"}'s official domain ${officialDomain}.`);
        else facts.push(`${d}: the sender's official domain could not be confirmed, so this link can't be compared.`);
      }
      linkCheck = facts.join(" ");
    }

    // Fraud-warning page on the official site, and (job offers) the real careers page — both give the agent
    // a deep start URL so it spends its time checking, not navigating from the homepage.
    const [fraudHits, careerHits] = officialDomain
      ? await Promise.all([
          search(`${sender || officialDomain} fraud scam phishing warning`, {
            includeDomains: [officialDomain],
            purpose: "Find the organisation's own page about scams and how to report them",
          }),
          check.job?.company
            ? search(`${check.job.company} careers jobs`, { includeDomains: [officialDomain], purpose: "Find the company's official careers page" })
            : Promise.resolve([] as SearchHit[]),
        ])
      : [[] as SearchHit[], [] as SearchHit[]];
    const careersUrl = careerHits.find((h) => /career|job|join|hiring|work-with/i.test(h.url))?.url;

    // ── Step 2: FETCH: read the official warning page + top scam reports
    const toRead = [
      ...fraudHits.slice(0, 1).map((h) => h.url),
      ...(fraudHits.length ? [] : officialDomain ? [`https://${officialDomain}`] : []),
      ...reports.slice(0, 3).map((h) => h.url),
    ];
    officialSite = officialDomain;
    await progress(`📖 Reading what ${sender || "others"}${sender ? " and others say" : " say"} about this…`);

    // ── Step 3: AGENT (in parallel with Fetch): act on the real site.
    // Its live steps go into the progress bubble, throttled so we don't fire a burst of edits at iMessage.
    const agentLabel = check.job?.company ? `${check.job.company}'s job listings` : `${sender || officialDomain}'s website`;
    // The agent's raw steps read like robot logs ("Submit final search results"), so the user sees one calm
    // "still checking" line once it has been running a while. Edits are scarce (5 per message) anyway.
    const agentStart = Date.now();
    let nudged = false;
    const onStep = (_step: string) => {
      if (nudged || Date.now() - agentStart < 25_000) return;
      nudged = true;
      void progress(`⏳ Still checking ${agentLabel}, almost there…`);
    };
    const agentTask = (() => {
      // No confirmed official site → no agent run (a search-engine start page just hits captchas).
      if (check.job?.company && officialDomain) {
        return runAgent(
          careersUrl ?? `https://${officialDomain}`,
          `${careersUrl ? "This is" : "Go to"} ${check.job.company}'s official careers/jobs page. Search ONCE for a posting matching "${check.job.role}" ` +
            `using the site's own job search or listing (try the key words, e.g. "${check.job.role.split(/\s+/).slice(-2).join(" ")}"). ` +
            `Do not browse unrelated pages and do not repeat a search — report what you saw as soon as the results load. ` +
            `Return JSON: {"careers_page_url": string|null, "role_found": boolean, "closest_matching_title": string|null, ` +
            `"posting_url": string|null, "official_hiring_warning": string|null}. ` +
            `official_hiring_warning = any text on their site warning about fake recruiters or recruitment scams, quoted briefly. If not found, use null.`,
          { maxSeconds: 75, onStep }, // the headline check for job offers; careers sites are heavy, so it gets more time
        );
      }
      if (officialDomain) {
        return runAgent(
          fraudHits[0]?.url ?? `https://${officialDomain}`,
          `On this official website, find (1) how to report phishing or fraud and (2) the official customer support phone number or contact page. ` +
            `Navigate through Help/Contact/Security pages if needed. Return JSON: {"report_method": string|null, "report_page_url": string|null, ` +
            `"official_phone": string|null, "contact_page_url": string|null}. Only include values you actually saw on the site.`,
          { maxSeconds: 35, onStep }, // nice-to-have: don't make the user wait long for it
        );
      }
      return Promise.resolve(null);
    })();
    if (check.job?.company && officialDomain) await progress(`🧭 Searching ${check.job.company}'s real job listings…`);
    else if (officialDomain) await progress(`🧭 Visiting ${sender || officialDomain}'s official website…`);
    else notes.push("The organisation's official website could not be confirmed, so no live site check was done.");

    const [pages, agent] = await Promise.all([fetchPages(toRead, "Verify whether a message is a scam and how to report it"), agentTask]);

    for (const p of pages) {
      const isOfficial = officialDomain && regDomain(p.url) === officialDomain;
      add({ title: p.title, url: p.url, excerpt: excerpt(p.text), kind: isOfficial ? "official" : "report" });
    }
    if (agent?.ok && agent.result) {
      const r = agent.result as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
      if (check.job?.company) {
        // Link the careers page itself (not the "closest" posting, which is a different job) and state the finding plainly.
        const url = str(r.careers_page_url) ?? agent.url;
        const found = r.role_found === true;
        roleMissing = r.role_found === false;
        const lines = [
          `Sage's live check of ${check.job.company}'s official careers page (${url}), searching for "${check.job.role}":`,
          found
            ? `A matching posting WAS found${str(r.posting_url) ? ` at ${r.posting_url}` : ""}.`
            : `No matching posting was found.${str(r.closest_matching_title) ? ` Closest listing: "${r.closest_matching_title}" (a different role).` : ""}`,
          str(r.official_hiring_warning) ? `The careers site warns: "${r.official_hiring_warning}"` : "",
        ];
        add({ title: `${check.job.company} careers page (checked live)`, url, excerpt: lines.filter(Boolean).join("\n"), kind: "agent" });
      } else {
        const url = str(r.report_page_url) ?? str(r.contact_page_url) ?? agent.url;
        const lines = [
          `Sage's live check of ${officialDomain}'s official website:`,
          str(r.report_method) ? `How to report fraud: ${r.report_method}` : "No fraud-reporting instructions were found.",
          str(r.official_phone) ? `Official support phone shown on the site: ${r.official_phone}` : "",
          str(r.contact_page_url) ? `Official contact page: ${r.contact_page_url}` : "",
        ];
        add({ title: `${officialDomain} (checked live)`, url, excerpt: lines.filter(Boolean).join("\n"), kind: "agent" });
      }
    } else if (agent && !agent.ok) {
      notes.push(`Live site check could not complete (${agent.note}). Do not claim anything from it.`);
    }
    // Search snippets as weaker supporting evidence
    for (const h of reports.slice(0, 3)) add({ title: h.title, url: h.url, excerpt: h.snippet, kind: "search" });
  } else {
    // ── Fact-check path: SEARCH news + fact-checks → FETCH the best ones
    const claim = check.claim?.trim() || check.summary;
    await progress("🔎 Looking for news and fact-checks…");
    const [news, factchecks] = await Promise.all([
      search(claim.slice(0, 200), { news: true, purpose: "Find credible news coverage of this claim" }),
      search(`${claim.slice(0, 160)} fact check`, { purpose: "Find fact-checks of this claim" }),
    ]);
    const best = [...factchecks.slice(0, 2), ...news.slice(0, 2)].filter((h) => !SOCIAL.test(h.url));
    await progress(`📖 Reading ${best.length} trusted source${best.length === 1 ? "" : "s"}…`);
    const pages = await fetchPages(best.map((h) => h.url), "Fact-check a claim forwarded on social media");
    for (const p of pages) add({ title: p.title, url: p.url, excerpt: excerpt(p.text), kind: "news" });
    for (const h of [...factchecks, ...news].filter((h) => !SOCIAL.test(h.url)).slice(0, 4)) add({ title: h.title, url: h.url, excerpt: h.snippet, kind: "search" });
  }

  await progress("🧠 Putting it all together…");
  let judgement = await judge({ language, check, linkCheck, sources, extraNotes: notes });

  // The schema enforces English verdict codes; this is the backstop if a model ignores it.
  // Any of the 8 codes is fine: if intake mis-typed a message as a "claim", the judge's scam-style verdict is still right
  // (live testing: a real Google email got LOOKS_REAL, which the old per-type check forced to "Unproven").
  const VALID = ["SCAM", "SUSPICIOUS", "CANT_CONFIRM", "LOOKS_REAL", "FALSE", "MISLEADING", "UNVERIFIED", "TRUE"];
  if (!VALID.includes(judgement.verdict)) {
    console.warn(`[judge] unexpected verdict "${judgement.verdict}" → ${check.type === "scam" ? "CANT_CONFIRM" : "UNVERIFIED"}`);
    judgement.verdict = check.type === "scam" ? "CANT_CONFIRM" : "UNVERIFIED";
  }
  // A scam verdict must rest on red flags in this message, not on "scammers often impersonate X" (live testing: a real
  // Google security alert and a real salon booking came back SUSPICIOUS on generic grounds). The small model doesn't
  // always obey, so enforce it: drop flags the code can disprove, then require at least one.
  const verifiable = (j: Judgement) =>
    (j.red_flags ?? []).filter((f) => (f !== "link_not_official" || linkMismatch) && (f !== "role_not_on_official_site" || roleMissing));
  const unsupported = (j: Judgement) => (j.verdict === "SCAM" || j.verdict === "SUSPICIOUS") && verifiable(j).length === 0;
  if (unsupported(judgement)) {
    // Ask once for a rewrite, so the headline and advice match the honest verdict (not "this might be a trick").
    console.warn(`[judge] ${judgement.verdict} with no verifiable red flags → asking for a rewrite`);
    judgement = await judge({
      language, check, linkCheck, sources,
      extraNotes: [...notes, `A draft said ${judgement.verdict}, but no specific red flag in this message holds up. Write it as CANT_CONFIRM or LOOKS_REAL, with calm advice to check through the official app/site.`],
    }).catch(() => judgement);
    if (unsupported(judgement)) {
      judgement.verdict = "CANT_CONFIRM";
      if (judgement.labels) delete judgement.labels.verdict; // its translation was for the old verdict
    }
  }
  judgement.red_flags = verifiable(judgement);

  // Never fake a source: keep only citations that point at real fetched/searched items.
  const valid = new Set(sources.map((s) => s.id));
  // Strip any "[3]" markers the model wrote into prose — numbering is done in format.ts from source_ids only.
  const noRefs = (t: string) => t.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, "").trim();
  judgement.why = (judgement.why ?? []).map((w) => ({ text: noRefs(w.text), source_ids: (w.source_ids ?? []).filter((id) => valid.has(id)) }));
  judgement.do_now = (judgement.do_now ?? []).map(noRefs);
  judgement.verify_yourself = (judgement.verify_yourself ?? []).map(noRefs);
  const cited = [...new Set(judgement.why.flatMap((w) => w.source_ids))];
  const citedSources = cited.map((id) => sources.find((s) => s.id === id)!).filter(Boolean);
  if (judgement.official_contact && !contactIsTraceable(judgement.official_contact, sources)) {
    judgement.official_contact = null; // contact must be traceable to the official site
  }

  // The one page to preview: what the agent checked, else the official page we read, else the official homepage.
  const preview =
    citedSources.find((s) => s.kind === "agent")?.url ??
    citedSources.find((s) => s.kind === "official")?.url ??
    (officialSite ? `https://${officialSite}` : citedSources[0]?.url);
  const org = check.claimed_sender?.trim() || undefined;
  const checked = sources.filter((s) => s.kind !== "search").map((s) => s.url).slice(0, 5);
  const result: Investigation = { judgement, sources: citedSources, checkedCount: sources.length, fromCache: false, preview, org, checked };
  if (sources.length) cacheSet(key, result);
  return result;
}

/** "I already clicked" — find the real org's guidance and give calm next steps. */
export async function recover(about: string, sender: string | null, language: string, country = "Canada") {
  const hits = await search(`${sender ?? ""} what to do if you clicked a phishing link scam ${country}`.trim(), {
    purpose: "Find official guidance for someone who already responded to a scam",
  });
  const pages = await fetchPages(hits.filter((h) => !SOCIAL.test(h.url)).slice(0, 2).map((h) => h.url), "Steps after falling for a scam");
  const sources: Source[] = pages.map((p, i) => ({ id: i + 1, title: p.title, url: p.url, excerpt: excerpt(p.text, 1200), kind: "official" }));
  const plan = await damageControl(language, about, sources);
  const valid = new Set(sources.map((s) => s.id));
  return { plan, sources: sources.filter((s) => (plan.source_ids ?? []).filter((id) => valid.has(id)).includes(s.id)) };
}
