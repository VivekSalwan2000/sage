// How Sage looks in iMessage: short, scannable, the verdict first.

import type { Investigation } from "./investigate";
import type { Verdict } from "./brain";

const LABELS: Record<Verdict, string> = {
  SCAM: "🔴 SCAM",
  SUSPICIOUS: "🟠 SUSPICIOUS",
  CANT_CONFIRM: "🟡 CAN'T CONFIRM",
  LOOKS_REAL: "🟢 LOOKS REAL",
  FALSE: "🔴 FALSE",
  MISLEADING: "🟠 MISLEADING",
  UNVERIFIED: "🟡 UNVERIFIED",
  TRUE: "🟢 TRUE",
};

export const isBad = (v: Verdict) => v === "SCAM" || v === "SUSPICIOUS" || v === "FALSE";

const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

/** Main verdict bubble (markdown → native iMessage bold). */
export function verdictMessage(inv: Investigation): string {
  const j = inv.judgement;
  const lines: string[] = [];
  lines.push(`**${LABELS[j.verdict] ?? j.verdict}**`);
  lines.push(j.headline);
  if (j.why?.length) {
    lines.push("");
    lines.push("**Why**");
    for (const w of j.why.slice(0, 3)) {
      const refs = w.source_ids?.length ? ` ${w.source_ids.map((id) => `[${inv.sources.findIndex((s) => s.id === id) + 1}]`).join("")}` : "";
      lines.push(`• ${w.text}${refs}`);
    }
  }
  if (j.do_now?.length) {
    lines.push("");
    lines.push("**Do this now**");
    j.do_now.slice(0, 3).forEach((d, i) => lines.push(`${i + 1}. ${d}`));
  }
  return lines.join("\n");
}

/** Second bubble: how to verify it yourself + sources (kept separate so the verdict stays short). */
export function followupMessage(inv: Investigation): string | null {
  const j = inv.judgement;
  const lines: string[] = [];
  if (j.verify_yourself?.length || j.official_contact) {
    lines.push("**Check it yourself**");
    j.verify_yourself?.slice(0, 2).forEach((v) => lines.push(`• ${v}`));
    if (j.official_contact) lines.push(`• Official contact (from their real site): ${j.official_contact}`);
  }
  if (inv.sources.length) {
    if (lines.length) lines.push("");
    lines.push("**Sources**");
    inv.sources.slice(0, 4).forEach((s, i) => lines.push(`[${i + 1}] ${host(s.url)} — ${s.url}`));
  }
  return lines.length ? lines.join("\n") : null;
}

export function progressDone(inv: Investigation): string {
  return inv.fromCache ? "⚡ Checked recently — here's what I found" : `✓ Checked ${inv.checkedCount} live source${inv.checkedCount === 1 ? "" : "s"}`;
}

export const ONBOARDING = (name: string) =>
  `Hi, I'm ${name} 👋 Got a text, email, job offer, or forward that feels off? Send it to me — paste it, share the link, or send a screenshot — and I'll check it against the live web and tell you if it's legit.\n\nTip: text "add my mom +1 555…" and I can give family a heads-up when a scam is going around.`;

export const HELP = (name: string) =>
  `Here's what I can do:\n• Check if a text, email, DM or job offer is a scam\n• Fact-check forwards and posts\n• Tell you how to verify it yourself and who to report it to\n• Warn a family member (only if you say yes)\n\nJust send me the message or a screenshot.`;
