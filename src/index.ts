// Sage — entry point. Photon Spectrum delivers iMessages; this file decides what to do with them.

import { Spectrum, markdown, richlink, type Message, type Space } from "spectrum-ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { config, assertConfig } from "./config";
import { understand, type Media } from "./brain";
import { investigate, recover } from "./investigate";
import { verdictMessage, followupMessage, linksMessage, damageMessage, progressDone, ONBOARDING, HELP, COPY } from "./format";
import {
  getUser, updateUser, getPending, setPending, findUserByGuardianPhone,
  addTurn, recentTurns, saveCheck, recentChecks, lastCheckSources, usageGet, usageInc, type User,
} from "./db";

assertConfig();

const app = await Spectrum({
  ...(config.mode === "imessage"
    ? { projectId: config.spectrumProjectId, projectSecret: config.spectrumProjectSecret, providers: [imessage.config()] }
    : { providers: [terminal.config()] }),
} as any);

console.log(`\n✓ ${config.botName} is running (${config.mode}). Text it something suspicious.\n`);

// ---------- helpers ----------

const YES = /^(y|yes|yeah|yep|yup|sure|ok|okay|please|do it|go ahead|haan|ha|oui|sí|si)\b/i;
const NO = /^(n|no|nope|nah|don'?t|not now|non)\b/i;

async function say(space: Space, userId: string, text: string, md = false) {
  // House style: no dashes mid-sentence, even if the model slips one into a free-form reply.
  const tidy = text.replace(/[ \t]+[—–][ \t]+/g, ", ");
  addTurn(userId, "sage", tidy);
  return space.send(md ? markdown(tidy) : tidy);
}

async function safeReact(message: Message, emoji: string) {
  try {
    await message.react(emoji);
  } catch {
    /* tapbacks are a nicety */
  }
}

/** Masks a phone number for logs: +19055551234 → +1905***1234. */
const mask = (id: string) => id.replace(/^(\+?\d{4})\d+(\d{4})$/, "$1***$2");

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

// ---------- the brain of a turn ----------

async function handle(space: Space, senderId: string, messages: Message[]) {
  const last = messages[messages.length - 1]!;
  const { texts, media } = await collect(messages);
  if (!texts.length && !media.length) return;
  addTurn(senderId, "user", texts.join("\n") + (media.length ? ` [+${media.length} attachment]` : ""));

  // 1) Is this a guardian answering an invite?
  const inviter = findUserByGuardianPhone(senderId);
  if (inviter && texts.length && (YES.test(texts[0]!) || NO.test(texts[0]!))) {
    const accepted = YES.test(texts[0]!);
    updateUser(inviter.id, { guardian_status: accepted ? "confirmed" : null, ...(accepted ? {} : { guardian_phone: null, guardian_name: null }) });
    await say(space, senderId, accepted ? COPY.guardianYes(inviter.name ?? "they") : COPY.guardianNo);
    const who = inviter.guardian_name ?? "Your family contact";
    await textNumber(inviter.id, accepted ? COPY.guardianAccepted(who) : COPY.guardianDeclined(who));
    return;
  }

  let user = getUser(senderId);

  // 2) First time: welcome + save the contact card vibe.
  if (!user.onboarded) {
    updateUser(senderId, { onboarded: 1 });
    const onlyHello = media.length === 0 && texts.join(" ").trim().length < 25;
    await say(space, senderId, ONBOARDING(config.botName), true);
    if (onlyHello) return;
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
      pending: pending ? (pending.type === "guardian_alert" ? `Want me to warn ${user.guardian_name}?` : `Confirm adding ${pending.name} ${pending.phone} as family contact?`) : null,
      history: recentTurns(senderId, 10),
      recentChecks: recentChecks(senderId),
    });
  } catch (e) {
    console.error("[understand]", e);
    await space.stopTyping().catch(() => {});
    await say(space, senderId, COPY.cantRead);
    return;
  }
  if (u.language && u.language !== user.language) updateUser(senderId, { language: u.language });

  switch (u.intent) {
    case "yes":
    case "no":
      if (pending) return resolvePending(space, user, pending, u.intent === "yes");
      return say(space, senderId, u.reply ?? "Got it 👍");

    case "set_name":
      if (u.name) updateUser(senderId, { name: u.name });
      return say(space, senderId, u.reply ?? `Nice to meet you, ${u.name}!`);

    case "set_guardian": {
      if (!u.guardian?.phone || !/^\+\d{10,15}$/.test(u.guardian.phone)) {
        return say(space, senderId, COPY.askNumber);
      }
      if (u.guardian.phone === senderId) return say(space, senderId, COPY.ownNumber);
      setPending(senderId, { type: "confirm_guardian", name: u.guardian.name || "your contact", phone: u.guardian.phone });
      return say(space, senderId, COPY.confirmGuardian(u.guardian.name || "them", u.guardian.phone));
    }

    case "help":
      return say(space, senderId, HELP(config.botName), true);

    case "links":
      return say(space, senderId, linksMessage(lastCheckSources(senderId).map((url) => ({ url }))), true);

    case "followup":
      return say(space, senderId, u.reply ?? "That's my answer from the check above. Send any new details and I'll look again.");

    case "need_screenshot":
    case "chat":
      return say(space, senderId, u.reply ?? "Send me the message or a screenshot and I'll check it.");

    case "already_clicked": {
      await safeReact(last, "❤️");
      const about = u.check?.summary ?? texts.join(" ");
      try {
        const { plan, sources } = await space.responding(() => recover(about, u.check?.claimed_sender ?? null, u.language ?? "en"));
        return say(space, senderId, damageMessage(plan, sources), true);
      } catch (e) {
        console.error("[recover]", e);
        return say(space, senderId, COPY.damageFallback, true);
      }
    }

    case "check":
    default:
      if (!u.check) return say(space, senderId, u.reply ?? "Send me the message or a screenshot and I'll check it.");
      return runCheck(space, user, last, u.check, u.language ?? "en");
  }
}

async function runCheck(space: Space, user: User, last: Message, check: NonNullable<Awaited<ReturnType<typeof understand>>["check"]>, language: string) {
  // Rate limit per user/day (protects free tiers + credits).
  const key = `checks:${user.id}`;
  if (usageGet(key) >= config.checksPerUserPerDay) {
    return say(space, user.id, COPY.dailyLimit(config.checksPerUserPerDay));
  }
  usageInc(key);

  await safeReact(last, "‼️"); // instant "got it" — iMessage tapback
  addTurn(user.id, "sage", "(checking…)");

  // One progress bubble, edited in place. iMessage allows only 5 edits per message (later ones are silently
  // dropped — the bubble froze mid-check in live testing), so: the first update is a fresh send, then at most
  // 4 edits, with the last edit reserved for the final "✓ Checked…" line. Updates are queued so they land in order.
  const MAX_EDITS = 5;
  let progressMsg: Message | undefined;
  let edits = 0;
  let queue: Promise<void> = Promise.resolve();
  const update = (line: string, final = false) => {
    queue = queue.then(async () => {
      try {
        if (!progressMsg) {
          progressMsg = (await space.send(line)) ?? undefined;
          return;
        }
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
    const inv = await space.responding(() => investigate(check, language, progress));
    await update(progressDone(inv), true);
    await say(space, user.id, verdictMessage(inv), true);
    const follow = followupMessage(inv);
    if (follow) await say(space, user.id, follow, true);
    // One website preview card (title + image) instead of a list of long links. Best-effort.
    if (inv.preview) await space.send(richlink(inv.preview)).catch((e) => console.warn("[preview]", (e as Error).message));

    const j = inv.judgement;
    const checkId = saveCheck(user.id, check.type, j.verdict, j.headline, check.summary, inv.sources.map((s) => s.url));

    // The "right moment": only after a clear SCAM verdict, only if a confirmed guardian exists, only with consent.
    // (Not after SUSPICIOUS — in live testing the tip fired on a real salon booking text.)
    if (j.verdict === "SCAM") {
      if (user.guardian_status === "confirmed" && user.guardian_phone) {
        setPending(user.id, { type: "guardian_alert", checkId, summary: j.headline });
        await say(space, user.id, COPY.offerAlert(user.guardian_name ?? "your family contact"));
      } else if (!user.guardian_tip_shown) {
        updateUser(user.id, { guardian_tip_shown: 1 });
        await say(space, user.id, COPY.guardianTip);
      }
    }
  } catch (e) {
    console.error("[check]", e);
    await update("⚠️ Couldn't finish this check", true);
    await say(space, user.id, COPY.checkFailed, true);
  }
}

async function resolvePending(space: Space, user: User, pending: NonNullable<ReturnType<typeof getPending>>, yes: boolean) {
  setPending(user.id, null);
  if (pending.type === "confirm_guardian") {
    if (!yes) return say(space, user.id, COPY.noContact);
    updateUser(user.id, { guardian_name: pending.name, guardian_phone: pending.phone, guardian_status: "invited" });
    const ok = await textNumber(pending.phone, COPY.guardianInvite(user.name ?? "Someone in your family", config.botName));
    return say(space, user.id, ok ? COPY.guardianInviteSent(pending.name) : COPY.guardianUnreachable(pending.phone));
  }
  if (pending.type === "guardian_alert") {
    if (!yes) return say(space, user.id, COPY.noSend);
    const ok = await textNumber(user.guardian_phone!, COPY.guardianAlert(config.botName, user.name ?? "Your family member", pending.summary), true);
    return say(space, user.id, ok ? COPY.alertSent(user.guardian_name ?? "them") : COPY.alertFailed(user.guardian_name ?? "them"));
  }
}

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
  if (seen.size > 5000) seen.clear();

  const senderId = message.sender?.id ?? space.id;
  if (config.allowlist.length && !config.allowlist.includes(senderId)) {
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
