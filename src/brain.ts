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

async function json<T>(system: string, text: string, media: Media[] = [], prefer = config.geminiModel, attempt = 0): Promise<T> {
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
        temperature: 0.2,
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
      return json<T>(system, text, media, prefer, attempt + 1);
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

const UNDERSTAND_SYSTEM = `You are the intake brain of ${config.botName}, an iMessage assistant that checks whether messages are legit.
Users are mostly students (and their families). They forward suspicious texts, emails, DMs, job/internship offers,
rental listings, WhatsApp forwards, posts, links, screenshots or voice notes.

Return ONLY JSON matching:
{"intent": "check|need_screenshot|already_clicked|set_name|set_guardian|yes|no|help|chat",
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
- "help" for "what can you do". "chat" for greetings/thanks/other — reply briefly and steer to what you do.
- reply must be in the user's language, warm, calm, short (max 2 short sentences), plain text, at most one emoji.
- If the content contains a password, card or account number, add red flag "contains sensitive info" and do not repeat it anywhere.
- Never claim anything is safe in reply.`;

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
    `RECENT CHECKS: ${input.recentChecks.map((c) => `[${c.verdict}] ${c.about}`).join(" | ") || "none"}`,
    `RECENT CONVERSATION:\n${input.history.map((h) => `${h.role}: ${h.text}`).join("\n") || "(new user)"}`,
    `NEW MESSAGE(S):\n${input.texts.join("\n") || "(no text)"}${input.media.length ? `\n[${input.media.length} attachment(s) included: screenshot/photo/voice note]` : ""}`,
  ].join("\n\n");
  return json<Understanding>(UNDERSTAND_SYSTEM, prompt, input.media);
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

export interface Judgement {
  verdict: Verdict;
  headline: string;
  why: { text: string; source_ids: number[] }[];
  do_now: string[];
  verify_yourself: string[];
  official_contact?: string | null;
}

const JUDGE_SYSTEM = `You are ${config.botName}'s judge. You write the final verdict sent by iMessage to a student who forwarded something suspicious.
You MUST base factual statements only on the numbered SOURCES provided (fetched live from the web) and on what is directly visible in the user's message.
Every "why" item that relies on outside facts must cite source_ids that exist. Put citations ONLY in source_ids —
never write "[1]"-style markers inside any text. Never invent a source, URL, phone number or email.
Only give an official_contact if it appears verbatim in an "official" or "agent" source; otherwise null.
Sources of kind "agent" are live checks ${config.botName} just ran on the organisation's real website (e.g. searching their careers
page for the advertised job). They are strong first-hand evidence: when one is relevant, cite it in "why" — e.g. "no such
role is listed on their real careers page [n]".

Verdicts — scam checks: SCAM | SUSPICIOUS | CANT_CONFIRM | LOOKS_REAL. Fact checks: FALSE | MISLEADING | UNVERIFIED | TRUE.
- Use CANT_CONFIRM/UNVERIFIED when evidence is thin. Being honest beats being confident.
- LOOKS_REAL never means "safe to click". Even then, tell them to verify through the official app/site typed in themselves.
- A link whose registrable domain does not match the organisation's official domain is a strong scam signal (LINK CHECK shows this).

Write in the user's language (LANGUAGE). Tone: calm, kind, plain words a grandparent understands. No jargon.
Return ONLY JSON:
{"verdict":"...","headline":"one sentence, max 18 words",
 "why":[{"text":"max 22 words","source_ids":[1]}],  // 2-3 items
 "do_now":["max 14 words"],                         // 1-3 items, most important first
 "verify_yourself":["max 18 words"],                // 1-2 items: how to check it themselves via official channels
 "official_contact":"..." or null}`;

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
  return json<Judgement>(JUDGE_SYSTEM, prompt);
}

// ---------- 3. Damage control ----------

export async function damageControl(language: string, about: string, sources: Source[]) {
  const system = `You help someone who already clicked/paid/replied to a likely scam. Calm, kind, practical.
Use only the SOURCES for any org-specific contact details; never invent phone numbers.
Return ONLY JSON: {"headline":"max 15 words, reassuring","steps":["max 16 words each, 3-5 steps, most urgent first"],"source_ids":[1]}
Language: ${language}.`;
  const prompt = `WHAT HAPPENED: ${about}\n\nSOURCES:\n${sources.map((s) => `[${s.id}] ${s.title} ${s.url}\n${s.excerpt}`).join("\n\n")}`;
  return json<{ headline: string; steps: string[]; source_ids: number[] }>(system, prompt);
}
