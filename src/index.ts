// Sage — entry point. Photon Spectrum delivers iMessages; this file decides what to do with them.

import { Spectrum, markdown, richlink, type Message, type Space } from "spectrum-ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imessage, effect, nativeContactCard } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { config, assertConfig } from "./config";
import { understand, extractProfile, type Media } from "./brain";
import { withCountry } from "./tinyfish";
import { investigate, recover } from "./investigate";
import { verdictMessage, followupMessage, linksMessage, damageMessage, howToMessage, alertCard, progressDone, NUM, HELP, COPY } from "./format";
import {
  getUser, updateUser, getPending, setPending, findUserByGuardianPhone,
  addTurn, recentTurns, saveCheck, recentChecks, lastCheckSources, usageGet, usageInc, type User,
  scheduleFollowup, dueFollowups, markFollowupSent,
} from "./db";

assertConfig();

const app = await Spectrum({
  ...(config.mode === "imessage"
    ? { projectId: config.spectrumProjectId, projectSecret: config.spectrumProjectSecret, providers: [imessage.config()] }
    : { providers: [terminal.config()] }),
} as any);

console.log(`\n✓ ${config.botName} is running (${config.mode}). Text it something suspicious.\n`);

// ---------- helpers ----------

const YES = /^(y|yes|yeah|yep|yup|sure|ok|okay|please|do it|go ahead|try again|retry|again|done|all done|fixed|all good|haan|ha|oui|sí|si)\b/i;
const NO = /^(n|no|nope|nah|don'?t|not now|not yet|help|stuck|non)\b/i;

// iMessage bubble effects, used sparingly: a loud bubble for a scam, a gentle one for good news.
const FX_LOUD = "com.apple.MobileSMS.expressivesend.loud";
const FX_GENTLE = "com.apple.MobileSMS.expressivesend.gentle";

// Photon's connection occasionally drops mid-send ("UNAVAILABLE: read ECONNRESET"). In live testing that turned a
// finished check into "I couldn't finish this check", so sends are retried before giving up.
const SEND_RETRYABLE = /UNAVAILABLE|ECONNRESET|DEADLINE|timed? ?out|socket|internalError/i;
async function send(space: Space, content: Parameters<Space["send"]>[0]) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await space.send(content);
    } catch (e) {
      if (attempt >= 2 || !SEND_RETRYABLE.test(String((e as Error)?.message ?? e))) throw e;
      console.warn(`[send] retrying after: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

async function say(space: Space, userId: string, text: string, md = false, fx?: string) {
  // House style: no dashes mid-sentence, even if the model slips one into a free-form reply.
  const tidy = text.replace(/[ \t]+[—–][ \t]+/g, ", ");
  addTurn(userId, "sage", tidy);
  const content = md ? markdown(tidy) : tidy;
  if (!fx) return send(space, content);
  // Effects are a nicety: if one is rejected, send the plain bubble instead.
  return send(space, effect(content, fx as Parameters<typeof effect>[1])).catch(() => send(space, content));
}

async function safeReact(message: Message, emoji: string) {
  try {
    await message.react(emoji);
  } catch {
    /* tapbacks are a nicety */
  }
}

/** iMessage addresses compare case-insensitively for emails ("Name@Gmail.com" = "name@gmail.com"). */
const normalizeHandle = (h: string) => (h.includes("@") ? h.trim().toLowerCase() : h.trim());
const isHandle = (h: string) => /^\+\d{10,15}$/.test(h) || /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(h);

/** Masks a phone number for logs: +19055551234 → +1905***1234. */
const mask = (id: string) =>
  id.includes("@") ? id.replace(/^(.{2})[^@]*(@.*)$/, "$1***$2") : id.replace(/^(\+?\d{4})\d+(\d{4})$/, "$1***$2");

// Gemini accepts these audio types; iMessage voice notes are usually Core Audio (.caf), which it rejects.
const GEMINI_AUDIO = /^audio\/(wav|x-wav|mp3|mpeg|aiff|x-aiff|aac|ogg|flac)$/;

/** Converts an unsupported audio clip to 16 kHz mono WAV with macOS's built-in afconvert. */
async function toWav(buf: Buffer): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), "sage-audio-"));
  try {
    const src = join(dir, "in.caf");
    const out = join(dir, "out.wav");
    await writeFile(src, buf);
    const proc = Bun.spawn(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", src, out], { stderr: "pipe" });
    if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
    return await readFile(out);
  } catch (e) {
    console.warn("[audio] conversion failed:", (e as Error).message);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Collect text + media from one or more inbound messages. */
async function collect(messages: Message[]) {
  const texts: string[] = [];
  const media: Media[] = [];
  const visit = async (m: Message) => {
    const c: any = m.content;
    try {
      if (c.type === "text") texts.push(c.text);
      else if (c.type === "richlink") texts.push(c.url);
      else if ((c.type === "attachment" || c.type === "voice") && media.length < 3) {
        let mime: string = c.mimeType ?? "";
        if (/^(image\/|audio\/|application\/pdf)/.test(mime)) {
          let buf: Buffer | null = await c.read();
          if (buf && mime.startsWith("audio/") && !GEMINI_AUDIO.test(mime)) {
            console.info(`[collect] converting ${mime} voice note to WAV`);
            buf = await toWav(buf);
            mime = "audio/wav";
          }
          // Gemini's inline limit is 20 MB per request after base64 (+33%), so keep raw media under ~14 MB.
          if (!buf) texts.push("[sent a voice note that couldn't be read]");
          else if (buf.length < 14 * 1024 * 1024) media.push({ mimeType: mime, base64: buf.toString("base64") });
          else texts.push(`[sent a file too large to read: ${c.name ?? mime}]`);
        } else texts.push(`[sent a file: ${c.name ?? mime}]`);
      } else if (c.type === "group") for (const item of c.items) await visit(item);
      else if (c.type === "reply") await visit({ ...m, content: c.content } as Message);
    } catch (e) {
      console.warn("[collect] could not read content:", (e as Error).message);
    }
  };
  for (const m of messages) await visit(m);
  return { texts, media };
}

/** Proactive message to someone (guardian). Asks-before-sending is enforced by callers. */
async function textNumber(phone: string, text: string, md = false): Promise<boolean> {
  if (config.mode !== "imessage") {
    console.log(`\n[would text ${phone}]: ${text}\n`);
    return true;
  }
  try {
    const im = imessage(app as any);
    const user = await im.user(phone);
    const dm = await im.space.create(user);
    await dm.send(md ? markdown(text) : text);
    return true;
  } catch (e) {
    console.warn(`[guardian] could not text ${phone}:`, (e as Error).message);
    return false;
  }
}

// ---------- first contact: build a profile before helping ----------

// A message sent before the profile was finished (often the scam itself). Memory only: screenshots are never stored.
const held = new Map<string, Message[]>();

/**
 * Two short questions on first contact: first name, then city and country (the country localises every web search,
 * e.g. CRA vs IRS). Nothing sensitive is asked. Returns true once the profile is complete.
 */
async function onboard(space: Space, user: User, texts: string[], hasMedia: boolean, messages: Message[]): Promise<boolean> {
  const text = texts.join(" ").trim();
  const looksLikeContent = hasMedia || text.length > 60; // a pasted message or screenshot, not an answer

  if (!user.profile_stage) {
    const justHello = !hasMedia && text.length < 25;
    if (!justHello) held.set(user.id, messages);
    updateUser(user.id, { profile_stage: "name", onboarded: 1 });
    await say(space, user.id, COPY.welcomeAskName(config.botName, !justHello), true);
    return false;
  }

  if (user.profile_stage === "name") {
    if (looksLikeContent) {
      held.set(user.id, messages);
      await say(space, user.id, COPY.holdAndAskName);
      return false;
    }
    const p = await extractProfile("name", text).catch(() => ({ name: null }));
    if (!p.name) {
      await say(space, user.id, COPY.askNameAgain);
      return false;
    }
    updateUser(user.id, { name: p.name, profile_stage: "location" });
    await say(space, user.id, COPY.askLocation(p.name));
    return false;
  }

  if (user.profile_stage === "location") {
    if (looksLikeContent) {
      held.set(user.id, messages);
      await say(space, user.id, COPY.holdAndAskLocation);
      return false;
    }
    const p = await extractProfile("location", text).catch(() => ({ city: null, country: null, country_code: null }));
    if (!p.country_code || !/^[A-Za-z]{2}$/.test(p.country_code)) {
      await say(space, user.id, COPY.askLocationAgain);
      return false;
    }
    updateUser(user.id, { city: p.city ?? null, country: p.country ?? null, country_code: p.country_code.toUpperCase(), profile_stage: "done" });
    await say(space, user.id, COPY.profileDone(user.name ?? "there", held.has(user.id)), true);
    // Share Sage's own contact card (name + photo) so it's saved as "Sage", not a number. Best-effort and never
    // awaited: it's a control signal whose send may not resolve, and onboarding must not hang on it.
    void Promise.race([send(space, nativeContactCard()), new Promise((r) => setTimeout(r, 5000))]).catch((e) =>
      console.warn("[contact card]", (e as Error).message),
    );
    return true;
  }
  return true;
}

// ---------- the brain of a turn ----------

async function handle(space: Space, senderId: string, messages: Message[]) {
  const last = messages[messages.length - 1]!;
  const { texts, media } = await collect(messages);
  if (!texts.length && !media.length) return;
  addTurn(senderId, "user", texts.join("\n") + (media.length ? ` [+${media.length} attachment]` : ""));

  // 1) Is this a guardian answering an invite?
  // (Skipped if the sender is also a Sage user with their own yes/no question waiting, so that answer isn't stolen.)
  const inviter = findUserByGuardianPhone(normalizeHandle(senderId));
  const ownPending = getPending(getUser(senderId));
  if (inviter && !ownPending && texts.length && (YES.test(texts[0]!) || NO.test(texts[0]!))) {
    const accepted = YES.test(texts[0]!);
    updateUser(inviter.id, { guardian_status: accepted ? "confirmed" : null, ...(accepted ? {} : { guardian_phone: null, guardian_name: null }) });
    await say(space, senderId, accepted ? COPY.guardianYes(inviter.name ?? "your family member") : COPY.guardianNo);
    const who = inviter.guardian_name ?? "Your family contact";
    await textNumber(inviter.id, accepted ? COPY.guardianAccepted(who) : COPY.guardianDeclined(who));
    return;
  }

  let user = getUser(senderId);

  // 2) Profile first: Sage learns who it's helping (first name, city and country) before any check.
  if (user.profile_stage !== "done") {
    const finished = await onboard(space, user, texts, media.length > 0, messages);
    if (!finished) return;
    // Anything they sent before finishing (e.g. the scam itself) is checked now.
    const waiting = held.get(senderId);
    held.delete(senderId);
    if (waiting?.length) return handle(space, senderId, waiting);
    return;
  }

  const pending = getPending(user);

  // 3) Fast paths: "links" for the last check's full links, and yes/no to a pending question.
  if (texts.length === 1 && !media.length && /^\s*(links?|sources?|liens?|enlaces?)\s*\??\s*$/i.test(texts[0]!)) {
    return say(space, senderId, linksMessage(lastCheckSources(senderId).map((url) => ({ url }))), true);
  }
  if (pending && texts.length === 1 && !media.length && (YES.test(texts[0]!.trim()) || NO.test(texts[0]!.trim()))) {
    await resolvePending(space, user, pending, YES.test(texts[0]!.trim()));
    return;
  }

  // 4) Understand (Gemini reads text, screenshots, and voice notes).
  await space.startTyping().catch(() => {});
  let u;
  try {
    u = await understand({
      texts, media,
      userName: user.name,
      guardian: user.guardian_phone ? `${user.guardian_name} (${user.guardian_status})` : null,
      pending: !pending
        ? null
        : pending.type === "guardian_alert"
          ? `Want me to warn ${user.guardian_name}?`
          : pending.type === "retry_check"
            ? "The last check failed. Should I try it again?"
            : pending.type === "share_card"
              ? "Want an alert card you can forward to family?"
              : pending.type === "checkin"
                ? "Did you get through the safety steps Sage sent? (done / help)"
                : `Confirm adding ${pending.name} ${pending.phone} as family contact?`,
      history: recentTurns(senderId, 10),
      recentChecks: recentChecks(senderId),
      location: [user.city, user.country].filter(Boolean).join(", ") || null,
    });
  } catch (e) {
    console.error("[understand]", e);
    await space.stopTyping().catch(() => {});
    await say(space, senderId, COPY.cantRead);
    return;
  }
  if (u.language && u.language !== user.language) updateUser(senderId, { language: u.language });


  // Content to check always gets a real check, even if the model filed it as a follow-up (a repeated scam text did).
  if (u.check && (u.intent === "followup" || u.intent === "chat") && (media.length || texts.join(" ").length > 60)) {
    return runCheck(space, user, last, u.check, u.language ?? "en");
  }

  switch (u.intent) {
    case "yes":
    case "no":
      if (pending) return resolvePending(space, user, pending, u.intent === "yes");
      return say(space, senderId, u.reply ?? "Got it 👍");

    case "set_name":
      if (u.name) updateUser(senderId, { name: u.name });
      return say(space, senderId, u.reply ?? `Nice to meet you, ${u.name}!`);

    case "set_guardian": {
      // A family contact is any iMessage address: a phone number or an Apple ID email.
      const address = normalizeHandle(u.guardian?.phone ?? "");
      if (!isHandle(address)) return say(space, senderId, COPY.askNumber);
      if (address === normalizeHandle(senderId)) return say(space, senderId, COPY.ownNumber);
      setPending(senderId, { type: "confirm_guardian", name: u.guardian?.name || "your contact", phone: address });
      return say(space, senderId, COPY.confirmGuardian(u.guardian?.name || "them", address));
    }

    case "help":
      return say(space, senderId, HELP(config.botName), true);

    case "links":
      return say(space, senderId, linksMessage(lastCheckSources(senderId).map((url) => ({ url }))), true);

    case "followup":
      if (u.steps?.length) return say(space, senderId, howToMessage(u.title, u.reply, u.steps), true);
      return say(space, senderId, u.reply ?? "That's my answer from the check above. Send any new details and I'll look again.");

    case "need_screenshot":
    case "chat":
      if (u.steps?.length) return say(space, senderId, howToMessage(u.title, u.reply, u.steps), true);
      return say(space, senderId, u.reply ?? "Send me the message or a screenshot and I'll check it.");

    case "already_clicked": {
      await safeReact(last, "❤️");
      const about = u.check?.summary ?? texts.join(" ");
      try {
        const { plan, sources } = await space.responding(() =>
          withCountry(user.country_code, () => recover(about, u.check?.claimed_sender ?? null, u.language ?? "en", user.country ?? "Canada")),
        );
        await say(space, senderId, damageMessage(plan, sources), true);
        return scheduleCheckin(space, user, plan.steps.slice(0, 4).map((st, i) => `${NUM[i]} ${st.trim().replace(/\.+$/, "")}`).join("\n"));
      } catch (e) {
        console.error("[recover]", e);
        await say(space, senderId, COPY.damageFallback, true);
        return scheduleCheckin(space, user, COPY.damageFallback.split("\n").slice(1).join("\n"));
      }
    }

    case "check":
    default:
      if (!u.check) return say(space, senderId, u.reply ?? "Send me the message or a screenshot and I'll check it.");
      return runCheck(space, user, last, u.check, u.language ?? "en");
  }
}

type Check = NonNullable<Awaited<ReturnType<typeof understand>>["check"]>;

async function runCheck(space: Space, user: User, last: Message | undefined, check: Check, language: string) {
  if (getPending(getUser(user.id))?.type === "retry_check") setPending(user.id, null); // a new check replaces an old retry
  // Rate limit per user/day (protects free tiers + credits).
  const key = `checks:${user.id}`;
  if (usageGet(key) >= config.checksPerUserPerDay) {
    return say(space, user.id, COPY.dailyLimit(config.checksPerUserPerDay));
  }
  // Counted only after a check succeeds (below): a slow web / "try again" loop shouldn't burn the daily limit.

  if (last) await safeReact(last, "‼️"); // instant "got it" — iMessage tapback
  addTurn(user.id, "sage", "(checking…)");

  // One progress bubble, edited in place. iMessage allows only 5 edits per message (later ones are silently
  // dropped — the bubble froze mid-check in live testing), so: the first update is a fresh send, then at most
  // 4 edits, with the last edit reserved for the final "✓ Checked…" line. Updates are queued so they land in order.
  const MAX_EDITS = 5;
  let progressMsg: Message | undefined;
  let edits = 0;
  let started = false; // the first update is sent once; if the platform returns no handle, later ones are dropped
  let queue: Promise<void> = Promise.resolve();
  const update = (line: string, final = false) => {
    queue = queue.then(async () => {
      try {
        if (!started) {
          started = true;
          progressMsg = (await send(space, line)) ?? undefined;
          return;
        }
        if (!progressMsg) return;
        if (edits >= MAX_EDITS || (!final && edits >= MAX_EDITS - 1)) return;
        edits++;
        await progressMsg.edit(line);
      } catch (e) {
        console.warn("[progress]", (e as Error).message);
      }
    });
    return queue;
  };
  const progress = (line: string) => update(line);

  try {
    const inv = await space.responding(() => withCountry(user.country_code, () => investigate(check, language, progress)));
    await update(progressDone(inv), true);
    const v = inv.judgement.verdict;
    await say(space, user.id, verdictMessage(inv), true, v === "SCAM" || v === "FALSE" ? FX_LOUD : v === "LOOKS_REAL" || v === "TRUE" ? FX_GENTLE : undefined);
    const follow = followupMessage(inv);
    if (follow) await say(space, user.id, follow, true);
    // One website preview card (title + image) instead of a list of long links. Best-effort.
    if (inv.preview) await send(space, richlink(inv.preview)).catch((e) => console.warn("[preview]", (e as Error).message));

    if (!inv.fromCache) usageInc(key);
    const j = inv.judgement;
    const links = inv.sources.length ? inv.sources.map((s) => s.url) : inv.checked ?? [];
    const checkId = saveCheck(user.id, check.type, j.verdict, j.headline, check.summary, links);

    // The "right moment": only after a clear SCAM verdict, only if a confirmed guardian exists, only with consent.
    // (Not after SUSPICIOUS — in live testing the tip fired on a real salon booking text.)
    // Either way the user gets an alert card: sent straight to their family contact (if they have one) plus a copy
    // to forward, or just the forwardable card. Nothing is sent to anyone until they say yes.
    if (j.verdict === "SCAM") {
      const card = alertCard(inv);
      if (user.guardian_status === "confirmed" && user.guardian_phone) {
        setPending(user.id, { type: "guardian_alert", checkId, summary: j.headline, card });
        await say(space, user.id, COPY.offerAlert(user.guardian_name ?? "your family contact"));
      } else {
        setPending(user.id, { type: "share_card", card });
        await say(space, user.id, COPY.offerCard(!user.guardian_tip_shown));
        if (!user.guardian_tip_shown) updateUser(user.id, { guardian_tip_shown: 1 });
      }
    }
  } catch (e) {
    console.error("[check]", e);
    await update("⚠️ Couldn't finish this check", true);
    setPending(user.id, { type: "retry_check", check, language }); // "try again" re-runs it without resending
    await say(space, user.id, COPY.checkFailed, true).catch(() => {});
  }
}

async function resolvePending(space: Space, user: User, pending: NonNullable<ReturnType<typeof getPending>>, yes: boolean) {
  setPending(user.id, null);
  if (pending.type === "retry_check") {
    if (!yes) return say(space, user.id, COPY.noRetry);
    return runCheck(space, user, undefined, pending.check as Check, pending.language);
  }
  if (pending.type === "confirm_guardian") {
    if (!yes) return say(space, user.id, COPY.noContact);
    updateUser(user.id, { guardian_name: pending.name, guardian_phone: pending.phone, guardian_status: "invited" });
    // The guardian must know who's asking: the user's name if Sage knows it, else the last digits of their number.
    const who = user.name ?? `Someone texting from a number ending in ${user.id.replace(/\D/g, "").slice(-4)}`;
    const ok = await textNumber(pending.phone, COPY.guardianInvite(who, config.botName));
    return say(space, user.id, ok ? COPY.guardianInviteSent(pending.name) : COPY.guardianUnreachable(pending.phone));
  }
  if (pending.type === "guardian_alert") {
    if (!yes) return say(space, user.id, COPY.noSend);
    const card = pending.card ?? `⚠️ **Scam alert**\n${pending.summary}`;
    const ok = await textNumber(user.guardian_phone!, COPY.guardianAlert(config.botName, user.name ?? "Your family member", card), true);
    await say(space, user.id, ok ? COPY.alertSent(user.guardian_name ?? "them") : COPY.alertFailed(user.guardian_name ?? "them"));
    return say(space, user.id, card, true); // their own copy, to forward to anyone else
  }
  if (pending.type === "share_card") {
    if (!yes) return say(space, user.id, COPY.noSend);
    await say(space, user.id, pending.card, true);
    return say(space, user.id, COPY.cardForYou);
  }
  if (pending.type === "checkin") {
    return say(space, user.id, yes ? COPY.checkinDone : COPY.checkinHelp(pending.steps));
  }
}

// ---------- check-in after "I already clicked" ----------

/** One follow-up later ("did you change your password?"), saved in the database so it survives a restart. */
async function scheduleCheckin(space: Space, user: User, steps: string) {
  scheduleFollowup(user.id, config.checkinMinutes, "checkin", { steps });
  return say(space, user.id, COPY.checkinScheduled(config.checkinMinutes));
}

// Every 20 s, send any check-ins that are due, in the user's existing chat. One message each, never repeated.
setInterval(async () => {
  for (const f of dueFollowups()) {
    markFollowupSent(f.id); // first, so a slow send can never double-fire
    const user = getUser(f.user_id);
    const { steps } = JSON.parse(f.payload ?? "{}") as { steps?: string };
    const ok = await textNumber(f.user_id, COPY.checkin(user.name ?? "there"));
    if (ok) {
      setPending(f.user_id, { type: "checkin", steps: steps ?? "" });
      addTurn(f.user_id, "sage", COPY.checkin(user.name ?? "there"));
    }
  }
}, 20_000);

// ---------- inbound loop with burst debouncing ----------
// Users often send "look at this" + a screenshot as separate messages; wait briefly and handle them together.

const buffers = new Map<string, { space: Space; messages: Message[]; timer?: ReturnType<typeof setTimeout> }>();
const busy = new Set<string>();
const seen = new Set<string>();

function schedule(senderId: string) {
  const b = buffers.get(senderId);
  if (!b) return;
  if (b.timer) clearTimeout(b.timer);
  b.timer = setTimeout(async () => {
    if (busy.has(senderId)) return schedule(senderId); // finish the current check first
    buffers.delete(senderId);
    busy.add(senderId);
    try {
      await handle(b.space, senderId, b.messages);
    } catch (e) {
      console.error("[handle]", e);
      await b.space.send(COPY.somethingWrong).catch(() => {});
    } finally {
      busy.delete(senderId);
    }
  }, config.debounceMs);
}

for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;
  const t = (message.content as any).type;
  if (["read", "typing", "reaction", "poll_option", "addMember", "removeMember", "leaveSpace", "rename", "avatar"].includes(t)) continue;
  if (seen.has(message.id)) continue; // at-least-once delivery → dedupe
  seen.add(message.id);
  if (seen.size > 5000) for (const old of [...seen].slice(0, 1000)) seen.delete(old); // drop the oldest only

  const senderId = message.sender?.id ?? space.id;
  if (config.allowlist.length && !config.allowlist.map(normalizeHandle).includes(normalizeHandle(senderId))) {
    console.info(`[inbound] ignored ${t} from ${mask(senderId)} (not in ALLOWLIST)`);
    continue; // demo mode
  }
  console.info(`[inbound] ${t} from ${mask(senderId)}`);
  // Instant "I've got it" while the burst debounce waits for a possible follow-up screenshot.
  if (!buffers.has(senderId) && !busy.has(senderId)) space.startTyping().catch(() => {});

  const b = buffers.get(senderId) ?? { space, messages: [] };
  b.messages.push(message);
  b.space = space;
  buffers.set(senderId, b);
  schedule(senderId);
}
