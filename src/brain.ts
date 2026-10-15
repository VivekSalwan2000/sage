// Gemini = Sage's reading + writing layer (free tier).
// It never invents facts: it (1) understands what the user sent, and (2) writes a verdict
// strictly from sources TinyFish actually fetched. Source IDs are validated in code.

import { GoogleGenAI } from "@google/genai";
import { config } from "./config";

const ai = new GoogleGenAI({ apiKey: config.geminiKey });

export interface Media {
  mimeType: string;
  base64: string;
}

// Each call starts on `prefer` and alternates models on retry: a 503 "high demand" or a hung request on one
// model can last minutes while a user is waiting on their phone. Every attempt has a hard timeout.
const TRANSIENT = /429|RESOURCE_EXHAUSTED|50\d|UNAVAILABLE|INTERNAL|DOCTYPE|timed? ?out|abort|fetch failed|ECONNRESET|socket|JSON/i;

interface JsonOpts {
  media?: Media[];
  prefer?: string;
  /** JSON Schema the response must follow (Gemini enforces it, e.g. enum verdicts). */
  schema?: unknown;
  temperature?: number;
}

async function json<T>(system: string, text: string, opts: JsonOpts = {}, attempt = 0): Promise<T> {
  const { media = [], prefer = config.geminiModel, schema, temperature = 0.2 } = opts;
  const other = prefer === config.geminiModel ? config.geminiFallbackModel : config.geminiModel;
  const model = attempt % 2 === 0 ? prefer : other;
  try {
    const res = await ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [{ text }, ...media.map((m) => ({ inlineData: { mimeType: m.mimeType, data: m.base64 } }))],
        },
      ],
      config: {
        systemInstruction: system,
        responseMimeType: "application/json",
        temperature,
        ...(schema ? { responseJsonSchema: schema } : {}),
        httpOptions: { timeout: config.geminiTimeoutMs },
      },
    });
    const raw = (res.text ?? "").trim().replace(/^```json\s*|```$/g, "");
    return JSON.parse(raw) as T;
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (attempt < 3 && TRANSIENT.test(msg)) {
      const next = (attempt + 1) % 2 === 0 ? prefer : other;
      console.warn(`[gemini] ${model} failed (${msg.replace(/\s+/g, " ").slice(0, 80)}); retrying with ${next}`);
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      return json<T>(system, text, opts, attempt + 1);
    }
    throw e;
  }
}

// ---------- 1. Understand ----------

export type Intent =
  | "check" // something to verify (text, screenshot, link, forward, voice note, or a clear description)
  | "need_screenshot" // they described a situation but we need the actual message
  | "already_clicked" // they acted on a scam: damage control
  | "set_name"
  | "set_guardian"
  | "yes"
  | "no"
  | "help"
  | "followup" // a question about the check Sage just did — answered from memory, no new web run
  | "links" // wants the full source links of the last check
  | "chat";

export interface Understanding {
  intent: Intent;
  language: string; // ISO code of the user's language
  reply?: string; // for non-check intents: short, warm reply in the user's language
  name?: string;
  guardian?: { name: string; phone: string };
  check?: {
    type: "scam" | "claim";
    summary: string; // one line: what was sent
    claimed_sender?: string | null; // org/person it claims to be from
    official_domain_guess?: string | null; // e.g. canadapost.ca — your best knowledge, verified later
    links?: string[]; // URLs/domains visible in the content
    phone_numbers?: string[];
    key_phrase?: string | null; // distinctive phrase to search for reports
    claim?: string | null; // for fact-checks: the specific factual claim
    job?: { company: string; role: string } | null; // job/internship offers
    red_flags?: string[]; // what you can see directly (urgency, gift cards, typos, etc.)
  };
}

// One voice for every word Sage writes. Readers are any age and any comfort level with tech, so: plain words,
// short lines, no jargon, and none of the tells of AI writing (rules adapted from the "humanizer" skill,
// which is based on Wikipedia's "Signs of AI writing").
export const STYLE = `WRITING STYLE (applies to every text you write):
- Plain words a 12-year-old or a grandparent understands. Short sentences. Calm, warm, confident, never preachy.
- Say "website" or "website address", never "domain" or "URL". Say "fake message", never "phishing". Never use: spoofed,
  infrastructure, credentials, authenticate, malware, DKIM, vector, protocol, legitimate (say "real").
- No dashes of any kind (— – --) inside sentences; use a full stop or comma instead.
- Never use: crucial, key (as an adjective), robust, delve, highlight, valuable, additionally, ensure, leverage, seamless,
  "it's important to note", "not just X but Y", "could potentially", "I hope this helps", "let me know".
- No exclamation marks. No ALL CAPS. No emojis inside your text (the app adds its own).
- Every item is one short line. Steps start with a verb ("Delete the text", "Call the number on your card").`;

const UNDERSTAND_SYSTEM = `You are the intake brain of ${config.botName}, an iMessage assistant that checks whether messages are legit.
Users are everyday people of any age — students, workers, parents, grandparents. They forward suspicious texts, emails, DMs, job/internship offers,
rental listings, WhatsApp forwards, posts, links, screenshots or voice notes.

Return ONLY JSON matching:
{"intent": "check|need_screenshot|already_clicked|set_name|set_guardian|yes|no|help|followup|links|chat",
 "language": "en", "reply": "...", "name": "...", "guardian": {"name":"Mom","phone":"+15551234567"},
 "check": {"type":"scam|claim","summary":"...","claimed_sender":"...","official_domain_guess":"...",
           "links":[],"phone_numbers":[],"key_phrase":"...","claim":"...","job":{"company":"...","role":"..."},"red_flags":[]}}

Rules:
- "check" when there is content to verify (pasted text, screenshot, link, voice note) OR the description alone is specific enough to research (e.g. "text says CRA owes me $430, click link").
  type "scam" = messages asking you to do something (click, pay, log in, call, apply, send info). type "claim" = news/facts/rumours/forwards to fact-check.
- "need_screenshot" when they describe something vague ("I got a weird email"). reply: ask them to send a screenshot, with simple how-to (iPhone: press side button + volume up; then tap + in Messages and send it). Never ask for passwords or account numbers.
- "already_clicked" when they say they clicked, paid, replied, or shared info with something suspicious.
- "set_guardian" when they ask to add/link a family member who should be warned about scams. phone must be E.164 (assume +1 if 10 digits). If no number given, use intent "chat" and ask for it.
- "yes"/"no" when the message is just answering a yes/no question the assistant asked (see PENDING).
- "followup" when they ask about a check in RECENT CHECKS without sending anything new to check ("so is it legit?", "why?",
  "are you sure?", "what should I do?"). reply: answer from that check in max 3 short sentences, using its verdict and headline.
  Never change or soften the verdict, and never call anything "safe". If they add genuinely new information, use "check" instead.
- "links" when they ask for the links or sources of the last check.
- "help" for "what can you do". "chat" for greetings/thanks/other — reply briefly and steer to what you do.
- reply must be in the user's language, max 2 short sentences, plain text, follows the WRITING STYLE below.
- If the content contains a password, card or account number, add red flag "contains sensitive info" and do not repeat it anywhere.
- Never claim anything is safe in reply.

${STYLE}`;

export async function understand(input: {
  texts: string[];
  media: Media[];
  userName: string | null;
  guardian: string | null;
  pending: string | null;
  history: { role: string; text: string }[];
  recentChecks: { verdict: string; headline: string; about: string }[];
}): Promise<Understanding> {
  const prompt = [
    `USER NAME: ${input.userName ?? "unknown"}`,
    `FAMILY CONTACT: ${input.guardian ?? "none"}`,
    `PENDING QUESTION SAGE ASKED: ${input.pending ?? "none"}`,
    `RECENT CHECKS (newest first): ${input.recentChecks.map((c) => `[${c.verdict}] ${c.about} → ${c.headline}`).join(" | ") || "none"}`,
    `RECENT CONVERSATION:\n${input.history.map((h) => `${h.role}: ${h.text}`).join("\n") || "(new user)"}`,
    `NEW MESSAGE(S):\n${input.texts.join("\n") || "(no text)"}${input.media.length ? `\n[${input.media.length} attachment(s) included: screenshot/photo/voice note]` : ""}`,
  ].join("\n\n");
  return json<Understanding>(UNDERSTAND_SYSTEM, prompt, { media: input.media });
}

// ---------- 2. Judge ----------

export interface Source {
  id: number;
  title: string;
  url: string;
  excerpt: string;
  kind: "official" | "report" | "news" | "agent" | "search";
}

export type Verdict = "SCAM" | "SUSPICIOUS" | "CANT_CONFIRM" | "LOOKS_REAL" | "FALSE" | "MISLEADING" | "UNVERIFIED" | "TRUE";

export const RED_FLAGS = [
  "link_not_official", // a link to a domain that isn't the organisation's (only valid if LINK CHECK found a mismatch/shortener)
  "asks_personal_info", // asks for SIN/ID, passwords, codes, bank/card details, or a reply with personal info
  "asks_payment", // asks for money, fees, gift cards, crypto or e-Transfer
  "deadline_or_threat", // threatens a penalty or loss if you don't act fast (suspension, fine, arrest, expiry)
  "unexpected_offer_or_prize", // a job, prize, refund or deal the person never applied for
  "role_not_on_official_site", // the advertised role/offer isn't on the real site (only valid if the agent checked)
  "org_says_never_sends_this", // an official source says the org never sends this kind of message
] as const;
export type RedFlag = (typeof RED_FLAGS)[number];

export interface Judgement {
  verdict: Verdict;
  headline: string;
  /** kind drives the marker: 🚩 red flag, ✅ reassuring, ℹ️ neutral note. */
  why: { text: string; kind?: "red_flag" | "reassuring" | "note"; source_ids: number[] }[];
  do_now: string[];
  verify_yourself: string[];
  official_contact?: string | null;
  /** Red-flag categories seen in THIS message. SCAM/SUSPICIOUS need at least one that survives code checks. */
  red_flags?: RedFlag[];
  /** Section headings in the user's language (only filled for non-English). */
  labels?: Partial<Record<"verdict" | "do_now" | "sources" | "more_links", string>>;
}

const str = { type: "string" };
const strList = { type: "array", items: str };
// Enforced by Gemini: verdict must be one of the English codes (the code relies on them), text fields are free-form.
const JUDGEMENT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["SCAM", "SUSPICIOUS", "CANT_CONFIRM", "LOOKS_REAL", "FALSE", "MISLEADING", "UNVERIFIED", "TRUE"] },
    headline: str,
    why: {
      type: "array",
      items: {
        type: "object",
        properties: { text: str, kind: { type: "string", enum: ["red_flag", "reassuring", "note"] }, source_ids: { type: "array", items: { type: "integer" } } },
        required: ["text", "kind", "source_ids"],
      },
    },
    do_now: strList,
    verify_yourself: strList,
    official_contact: { type: ["string", "null"] },
    red_flags: { type: "array", items: { type: "string", enum: [...RED_FLAGS] } },
    labels: {
      type: "object",
      properties: { verdict: str, do_now: str, sources: str, more_links: str },
    },
  },
  required: ["verdict", "red_flags", "headline", "why", "do_now", "verify_yourself"],
};

const JUDGE_SYSTEM = `You are ${config.botName}'s judge. You write the final verdict sent by iMessage to someone who forwarded something that feels off.
You MUST base factual statements only on the numbered SOURCES provided (fetched live from the web) and on what is directly visible in the user's message.
Every "why" item that relies on outside facts must cite source_ids that exist. Put citations ONLY in source_ids —
never write "[1]"-style markers inside any text. Never invent a source, URL, phone number or email.
Only give an official_contact if it appears verbatim in an "official" or "agent" source; otherwise null.
Sources of kind "agent" are live checks ${config.botName} just ran on the organisation's real website (e.g. searching their careers
page for the advertised job). They are strong first-hand evidence: when one is relevant, cite it in "why" (e.g. "No such
role is listed on Shopify's real careers page.").

Verdicts — scam checks: SCAM | SUSPICIOUS | CANT_CONFIRM | LOOKS_REAL. Fact checks: FALSE | MISLEADING | UNVERIFIED | TRUE.
Judge THIS message by its own red flags, not by its topic:
- Real red flags: a link whose domain is not the organisation's official domain (see LINK CHECK), asking for money, gift cards,
  passwords, SIN/ID/bank details, or a reply with personal info; pressure or deadlines; a job/prize you never applied for;
  the claimed role/offer not existing on the real site (agent check); sources reporting this exact wording as a scam.
- A page saying "scammers impersonate <org>" is NOT evidence that this particular message is fake — real orgs send real messages too.
- Use LINK CHECK's wording for links: never call a link "shortened" unless LINK CHECK says it is a URL shortener, and a link to a
  well-known platform LINK CHECK names (e.g. Square bookings) is normal for real businesses.
- First fill "red_flags" with ONLY the categories that apply to THIS message (empty list if none):
  link_not_official — LINK CHECK says a link does NOT match the official domain, or is a URL shortener;
  asks_personal_info — asks for SIN/ID, passwords, codes, bank/card details, or a reply with personal info;
  asks_payment — asks for money, a fee, gift cards, crypto or an e-Transfer;
  deadline_or_threat — threatens a penalty or loss if they don't act fast (suspension, fine, arrest, "expires today");
  unexpected_offer_or_prize — a job, prize, refund or deal they never applied for;
  role_not_on_official_site — an "agent" source says the advertised role/offer isn't on the real site;
  org_says_never_sends_this — an official source says the organisation never sends this kind of message.
  "Scammers often fake <org> messages" is never a red flag. A button or link whose destination you can't see (e.g. in a
  screenshot) is not a red flag — just tell them to open the official site/app directly instead of tapping it.
  SCAM or SUSPICIOUS with an empty red_flags list is not allowed.
- "Urgency" counts only with a deadline, threat or consequence ("expires today", "account will be suspended", "pay within
  24 hours"). Ordinary security wording from the real sender ("check your account activity", "secure your account") is normal.
- SCAM: two or more strong red flags, or one decisive one (mismatched payment/login link, request for SIN or passwords).
- SUSPICIOUS: one real red flag but not decisive.
- LOOKS_REAL: no red flags, nothing to click or pay, and it points the person to the official app/site — but still tell them to
  check through the official app/site typed in themselves. LOOKS_REAL never means "safe to click"; never write "safe".
- CANT_CONFIRM / UNVERIFIED: evidence is thin or mixed. Being honest beats being confident.
- do_now must fit the verdict: don't tell someone to report or block a message that looks real.

Write every text field in the user's language (LANGUAGE), following the WRITING STYLE.
If LANGUAGE is not English, also return "labels", short translations for display: verdict (the verdict word, e.g. French
SCAM → "Arnaque", CANT_CONFIRM → "Impossible à confirmer"; the "verdict" field itself always stays the English code),
do_now ("What to do"), sources ("Sources"), more_links ('Reply "links" for the full links').
Keep it short. The whole answer is read on a phone in 10 seconds.
Return ONLY JSON:
{"verdict":"...","headline":"one plain sentence, max 12 words, says what this is",
 "why":[{"text":"max 12 words","kind":"red_flag|reassuring|note","source_ids":[1]}],  // 2 items, 3 only if needed
 "do_now":["max 8 words, starts with a verb"],      // 2 different actions, most important first
 "verify_yourself":["max 12 words"],                // exactly 1, not a repeat of do_now: how to check it themselves via the official app/site
 "official_contact":"..." or null,
 "labels":{"verdict":"...","do_now":"...","sources":"...","more_links":"..."}}  // labels only if not English

${STYLE}`;

export async function judge(input: {
  language: string;
  check: NonNullable<Understanding["check"]>;
  linkCheck: string;
  sources: Source[];
  extraNotes: string[];
}): Promise<Judgement> {
  const src = input.sources
    .map((s) => `[${s.id}] (${s.kind}) ${s.title}\nURL: ${s.url}\n${s.excerpt}`)
    .join("\n\n---\n\n");
  const prompt = [
    `LANGUAGE: ${input.language}`,
    `WHAT THE USER SENT: ${JSON.stringify(input.check)}`,
    `LINK CHECK: ${input.linkCheck}`,
    input.extraNotes.length ? `AGENT NOTES:\n${input.extraNotes.join("\n")}` : "",
    `SOURCES:\n${src || "(no sources could be fetched)"}`,
  ].join("\n\n");
  // The verdict is the one call where judgement quality matters most, so it uses the stronger model (falls back on 429/503).
  return json<Judgement>(JUDGE_SYSTEM, prompt, { schema: JUDGEMENT_SCHEMA, prefer: config.geminiJudgeModel, temperature: 0 });
}

// ---------- 3. Damage control ----------

export async function damageControl(language: string, about: string, sources: Source[]) {
  const system = `You help someone who already clicked/paid/replied to a likely scam. Calm, kind, practical.
Use only the SOURCES for any org-specific contact details; never invent phone numbers.
Return ONLY JSON: {"headline":"max 10 words, calm and reassuring","steps":["max 10 words, starts with a verb"],"source_ids":[1]}
3 or 4 steps, most urgent first.
${STYLE}
Language: ${language}.`;
  const prompt = `WHAT HAPPENED: ${about}\n\nSOURCES:\n${sources.map((s) => `[${s.id}] ${s.title} ${s.url}\n${s.excerpt}`).join("\n\n")}`;
  return json<{ headline: string; steps: string[]; source_ids: number[] }>(system, prompt);
}
