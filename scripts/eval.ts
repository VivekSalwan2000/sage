// Runs the CONTEXT.md test set through the real pipeline and prints verdict + sources + timing.
//   bun run eval            → every text case
//   bun run eval 1 2 3 5    → only those cases
// Uses live APIs: Search/Fetch are free, Agent runs spend credits (scam cases with an official site).

import { readFileSync } from "node:fs";
import { understand, type Media } from "../src/brain";
import { investigate, recover } from "../src/investigate";
import { verdictMessage, followupMessage, progressDone } from "../src/format";

interface Case {
  id: number;
  text: string;
  image?: string; // path relative to repo root
  expect: string;
}

const CASES: Case[] = [
  {
    id: 1,
    text: "Congrats! You've been selected for a Remote Data Analyst internship at Shopify, $45/hr. Reply with your SIN to start onboarding.",
    expect: "🔴 SCAM; Agent checks Shopify careers",
  },
  {
    id: 2,
    text: "CRA: You have an outstanding refund of $428.17. Claim now at cra-refund-canada.com before it expires.",
    expect: "🔴 SCAM; link-domain mismatch vs canada.ca",
  },
  {
    id: 3,
    text: "Canada Post: your parcel is on hold due to unpaid duty of $1.99. Pay at canadapost-redelivery.info",
    expect: "🔴 SCAM",
  },
  {
    id: 4,
    text: "Canada Post: Your package has been delivered to your community mailbox. You can view delivery details in the Canada Post app.",
    expect: "🟢/🟡, never 'safe to click'",
  },
  {
    id: 5,
    text: "Forward this to everyone!! Starting next week WhatsApp will charge $0.99 per month unless you forward this message to 10 contacts. It was on the news.",
    expect: "🔴 FALSE or 🟠 MISLEADING with fact-check sources",
  },
  { id: 6, text: "I got a weird email", expect: "asks for a screenshot (no check run)" },
  { id: 7, text: "is this real??", image: "scripts/fixtures/shopify-scam.png", expect: "same as #1 (read from the screenshot)" },
  { id: 8, text: "I already clicked the link and entered my password", expect: "damage-control steps" },
  {
    id: 9,
    text: "Postes Canada : votre colis est en attente, droits impayés de 1,99 $. Payez sur canadapost-redelivery.info",
    expect: "reply in French",
  },
  {
    id: 10,
    text:
      "Google — Security alert. You allowed Muse access to some of your Google Account data. If you didn't allow Muse access, someone else may be trying to access your Google Account data. Take a moment now to check your account activity and secure your account. [Check activity]",
    expect: "🟡/🟢 — real Google alert; no specific red flags (live-test regression)",
  },
];

const wanted = process.argv.slice(2).map(Number).filter(Boolean);
const run = wanted.length ? CASES.filter((c) => wanted.includes(c.id)) : CASES;
const summary: string[] = [];

for (const c of run) {
  console.log(`\n${"═".repeat(70)}\n#${c.id}  ${c.text}\nexpect: ${c.expect}\n${"─".repeat(70)}`);
  const t0 = Date.now();
  try {
    const media: Media[] = c.image ? [{ mimeType: "image/png", base64: readFileSync(c.image).toString("base64") }] : [];
    const u = await understand({ texts: [c.text], media, userName: null, guardian: null, pending: null, history: [], recentChecks: [] });
    console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] intent=${u.intent} lang=${u.language} type=${u.check?.type ?? "-"} sender=${u.check?.claimed_sender ?? "-"} official_guess=${u.check?.official_domain_guess ?? "-"}`);

    if (u.intent === "already_clicked") {
      const { plan, sources } = await recover(u.check?.summary ?? c.text, u.check?.claimed_sender ?? null, u.language ?? "en");
      console.log(`\n${plan.headline}\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\nsources: ${sources.map((s) => s.url).join(", ") || "none"}`);
      summary.push(`#${c.id} already_clicked  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      continue;
    }
    if (u.intent !== "check" || !u.check) {
      console.log(`(reply) ${u.reply}`);
      summary.push(`#${c.id} ${u.intent}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      continue;
    }

    const inv = await investigate(u.check, u.language ?? "en", (l) => console.log(`  … [${((Date.now() - t0) / 1000).toFixed(1)}s] ${l}`));
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n── ${progressDone(inv)} (${secs}s) ──\n\n${verdictMessage(inv)}\n\n${followupMessage(inv) ?? ""}`);
    summary.push(`#${c.id} ${inv.judgement.verdict.padEnd(12)} ${secs}s  ${inv.sources.length} cited${inv.fromCache ? " (cache)" : ""}`);
  } catch (e) {
    console.error(`✗ crashed: ${(e as Error).message}`);
    summary.push(`#${c.id} CRASH  ${(e as Error).message.slice(0, 80)}`);
  }
}

console.log(`\n${"═".repeat(70)}\nSUMMARY\n${summary.join("\n")}`);
