// How Sage looks in iMessage. Every message Sage sends is laid out here, so the voice and layout stay consistent.
//
// The system:
//   • Colour = verdict, always first:  🔴 scam/false · 🟠 be careful · 🟡 can't confirm · 🟢 looks real/true
//   • Markers have one meaning each:    🚩 red flag · ✅ reassuring · ℹ️ note · 1️⃣ 2️⃣ 3️⃣ steps · 📞 official number
//   • One idea per line, no long URLs in the main bubbles, sources as short website names (full links on request)
//   • A check is three messages: verdict (what + why) → what to do (+ sources) → one website preview card

import type { Investigation } from "./investigate";
import type { Source, Verdict } from "./brain";

const COLOR: Record<Verdict, string> = {
  SCAM: "🔴", SUSPICIOUS: "🟠", CANT_CONFIRM: "🟡", LOOKS_REAL: "🟢", FALSE: "🔴", MISLEADING: "🟠", UNVERIFIED: "🟡", TRUE: "🟢",
};
const TITLE: Record<Verdict, string> = {
  SCAM: "Scam", SUSPICIOUS: "Be careful", CANT_CONFIRM: "Can't confirm", LOOKS_REAL: "Looks real",
  FALSE: "False", MISLEADING: "Misleading", UNVERIFIED: "Unproven", TRUE: "True",
};
const MARK = { red_flag: "🚩", reassuring: "✅", note: "ℹ️" } as const;
export const NUM = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];

/** "https://www.shopify.com/careers?x=1" → "shopify.com" */
export const site = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};
/** Full link without the scheme, so iMessage still makes it tappable but it reads shorter. */
const shortLink = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

/** Model text, tidied: no stray dashes or [n] markers, one line. */
const clean = (t: string) =>
  t
    .replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, "")
    .replace(/\s+[—–]\s+/g, ", ")
    .replace(/[—–]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

function labels(inv: Investigation) {
  const l = inv.judgement.labels ?? {};
  const v = inv.judgement.verdict;
  return {
    verdict: `${COLOR[v] ?? "🟡"} **${l.verdict?.trim() || TITLE[v] || v}**`,
    doNow: l.do_now || "What to do",
    sources: l.sources || "Sources",
    moreLinks: l.more_links || 'Reply "links" for the full links',
  };
}

/** List items read cleaner without a closing full stop. */
const item = (t: string) => clean(t).replace(/[.。]+$/, "");

/**
 * The marker follows the verdict so it's always consistent (the model tags most reasons as plain notes):
 * on a scam/suspicious/false verdict every reason is 🚩 unless it's explicitly reassuring; on a looks-real/true
 * verdict every reason is ✅ unless it's explicitly a red flag; on can't-confirm the model's own tag decides.
 */
function marker(v: Verdict, kind?: "red_flag" | "reassuring" | "note") {
  if (v === "SCAM" || v === "SUSPICIOUS" || v === "FALSE" || v === "MISLEADING") return kind === "reassuring" ? MARK.reassuring : MARK.red_flag;
  if (v === "LOOKS_REAL" || v === "TRUE") return kind === "red_flag" ? MARK.red_flag : MARK.reassuring;
  return MARK[kind ?? "note"] ?? MARK.note;
}

/** Message 1: the verdict, one-line summary, and the 2–3 reasons. */
export function verdictMessage(inv: Investigation): string {
  const j = inv.judgement;
  const lines = [labels(inv).verdict, clean(j.headline)];
  const why = (j.why ?? []).slice(0, 3);
  if (why.length) {
    lines.push("");
    for (const w of why) lines.push(`${marker(j.verdict, w.kind)} ${item(w.text)}`);
  }
  return lines.join("\n");
}

/** Message 2: numbered steps (ending with how to check it yourself), the official number, and short sources. */
export function followupMessage(inv: Investigation): string | null {
  const j = inv.judgement;
  const L = labels(inv);
  const steps = [...(j.do_now ?? []).slice(0, 2), ...(j.verify_yourself ?? []).slice(0, 1)].map(item).filter(Boolean);
  const lines: string[] = [];
  if (steps.length) {
    lines.push(`**${L.doNow}**`);
    steps.forEach((s, i) => lines.push(`${NUM[i]} ${s}`));
  }
  if (j.official_contact) lines.push("", `📞 ${inv.org ? `${inv.org}: ` : ""}${clean(j.official_contact)}`);
  const sites = [...new Set(inv.sources.map((s) => site(s.url)))].slice(0, 3);
  if (sites.length) lines.push("", `📚 ${L.sources}: ${sites.join(", ")}`, L.moreLinks);
  return lines.length ? lines.join("\n") : null;
}

/** The full links, only when someone asks for them. */
export function linksMessage(sources: Pick<Source, "url">[]): string {
  if (!sources.length) return "I don't have links saved for that check. Send the message again and I'll take another look.";
  return ["🔗 **Sources**", ...sources.slice(0, 5).map((s, i) => `${NUM[i]} ${shortLink(s.url)}`)].join("\n");
}

export function progressDone(inv: Investigation): string {
  return inv.fromCache ? "⚡ Checked this one recently" : `✅ Done · checked ${inv.checkedCount} source${inv.checkedCount === 1 ? "" : "s"}`;
}

// ---------- fixed messages ----------

export const ONBOARDING = (name: string) =>
  [
    `👋 Hi, I'm ${name}.`,
    "Got a text, email or offer that feels off? Send it to me and I'll check it against the web.",
    "",
    "📸 Send a screenshot",
    "💬 Or paste the message",
    "🔗 Or share the link",
    "",
    "You'll get a clear answer in about a minute.",
  ].join("\n");

export const HELP = (name: string) =>
  [
    `🛡️ **What ${name} can do**`,
    "🔎 Check if a text, email or job offer is a scam",
    "📰 Check if a forwarded story is true",
    "🧭 Show you how to check it yourself",
    "👨‍👩‍👧 Warn your family, only when you say yes",
    "",
    "Send me the message or a screenshot to start.",
  ].join("\n");

export const COPY = {
  cantRead: "😕 I couldn't read that one. Try sending it again in a minute.",
  checkFailed: [
    "⚠️ **I couldn't finish this check**",
    "The web was slow on my end. Until I can:",
    "1️⃣ Don't tap links or call numbers in it",
    "2️⃣ Open the official app or website yourself",
    "",
    'Reply "try again" and I\'ll redo it.',
  ].join("\n"),
  noRetry: "👍 Okay. Send it again any time.",
  dailyLimit: (n: number) =>
    `⏸️ You've used today's ${n} checks. I'll be ready again tomorrow.\nIf it's urgent, call the company using the number on their official website.`,
  somethingWrong: "😕 Something went wrong on my side. Please try again.",
  askNumber: '📇 What\'s their phone number? For example: add my mom +1 905 555 0123',
  ownNumber: "🙂 That's your own number. Who should I add?",
  confirmGuardian: (name: string, phone: string) =>
    `📇 I'll text ${name} at ${phone} to ask if they'd like scam alerts from you.\nSend it? Reply yes or no.`,
  guardianInviteSent: (name: string) => `✅ Sent. I'll tell you when ${name} replies.`,
  guardianUnreachable: (phone: string) => `😕 I couldn't reach ${phone}. Is that number right?`,
  noContact: "👍 Okay, I won't contact them.",
  noSend: "👍 Okay, I won't send anything.",
  offerAlert: (name: string) => `👨‍👩‍👧 Want me to warn ${name} about this scam?\nReply yes or no.`,
  guardianTip:
    '👨‍👩‍👧 Scams like this often reach family too. Text "add my mom +1 555 123 4567" and I can warn them next time. I\'ll always ask you first.',
  alertSent: (name: string) => `✅ Done. I've warned ${name}. 💙`,
  alertFailed: (name: string) => `😕 I couldn't reach ${name} just now.`,
  guardianInvite: (who: string, bot: string) =>
    [
      `👋 Hi, this is ${bot}, an assistant that checks if texts and emails are scams.`,
      `${who} would like me to warn you when a scam is going around.`,
      "",
      "Is that okay? Reply YES or NO.",
    ].join("\n"),
  guardianYes: (who: string) => `✅ Thanks, you're set. I'll only text you when ${who} asks me to warn you. 💙`,
  guardianNo: "👍 No problem. I won't contact you again.",
  guardianAccepted: (name: string) => `✅ ${name} said yes. I can now warn them about scams, and I'll always ask you first.`,
  guardianDeclined: (name: string) => `${name} said no, so I won't message them.`,
  guardianAlert: (bot: string, who: string, headline: string) =>
    [
      `⚠️ **Scam alert from ${bot}**`,
      `${who} asked me to warn you about a scam going around:`,
      `"${headline}"`,
      "",
      "🚫 Don't tap links or call numbers in messages like this.",
      `🛡️ Not sure about a message? Send it to me and I'll check it.`,
    ].join("\n"),
  damageFallback: [
    "🫶 **Don't worry. Let's fix this now.**",
    "1️⃣ Change that account's password",
    "2️⃣ Call your bank using the number on your card",
    "3️⃣ Watch your statements for anything odd",
  ].join("\n"),
};

/** A how-to answer as labelled steps ("How do I check my connected apps?"). */
export function howToMessage(title: string | undefined, intro: string | undefined, steps: string[]): string {
  const lines = [`🧭 **${item(title || "Here's how")}**`];
  if (intro?.trim()) lines.push(clean(intro));
  steps.slice(0, 5).forEach((s, i) => lines.push(`${NUM[i]} ${item(s)}`));
  return lines.join("\n");
}

/** Damage-control steps after "I already clicked". */
export function damageMessage(plan: { headline: string; steps: string[] }, sources: Pick<Source, "url">[]): string {
  const lines = [`🫶 **${item(plan.headline)}**`, ...plan.steps.slice(0, 4).map((s, i) => `${NUM[i]} ${item(s)}`)];
  const sites = [...new Set(sources.map((s) => site(s.url)))].slice(0, 2);
  if (sites.length) lines.push("", `📚 Sources: ${sites.join(", ")}`);
  return lines.join("\n");
}
