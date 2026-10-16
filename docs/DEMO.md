# Sage: 60-second demo and launch posts

The bounty asks the video to show: **the moment → send something real → the web work → the payoff.**
Judges also look for "remembers context and texts at the right moment" and "asks before anything is sent".
This script covers all of them in 60 seconds.

## Before recording

- [ ] `.env`: `CHECKIN_MINUTES=1`, `ALLOWLIST` includes your number (and the family contact's, if used). Restart Sage.
- [ ] `bun run smoke` passes. Run one check off-camera first, so search results and the Agent are warm.
- [ ] Photon profile shows the name **Sage** and the logo (`assets/sage-logo.png`), so the chat header reads "Sage", not a number.
- [ ] Phone on **Do Not Disturb**, full battery, a clean Messages thread with Sage (archive old test chats).
- [ ] Screenshot ready on the phone: `scripts/fixtures/shopify-scam.png` (fictional 555 sender, no real personal data).
- [ ] **Never show** real emails, phone numbers or a real person's messages on screen.
- [ ] Record the phone screen (Control Centre → Screen Recording). Optionally record the laptop terminal for one 3-second "web work" cut.

## Shot list (about 60 s)

| Time | On screen | Voiceover (read calmly) |
|---|---|---|
| 0:00–0:06 | Lock screen; the fake "Shopify internship, reply with your SIN" text arrives | "Every student gets these. A 'Shopify internship' that wants my SIN by text. Real, or a scam?" |
| 0:06–0:12 | Screenshot it, open the **Sage** chat, send the screenshot + "is this real?" | "So I just send it to Sage, an assistant that lives in iMessage." |
| 0:12–0:16 | ‼️ tapback appears instantly; typing dots | "It's on it right away." |
| 0:16–0:32 | The progress bubble updating: 🔎 Looking into this… → 📖 Reading what Shopify says… → 🧭 Searching Shopify's real job listings… → ⏳ Still checking… (speed this part up 2–3×) | "Behind the scenes, TinyFish searches the web for this scam, reads Shopify's real pages, and sends an agent onto Shopify's actual careers site to look for this job." |
| 0:32–0:42 | 🔴 **Scam** bubble lands (loud effect), then "What to do", sources, and the Shopify careers preview card | "Scam. No such role exists on Shopify's real careers page, and they'd never ask for your SIN. Clear steps, and every source is a page it actually read." |
| 0:42–0:50 | "Want an alert card you can forward to family?" → **yes** → the ⚠️ Scam alert card → press-and-hold → Forward | "These scams reach my parents too, so Sage gives me a warning card for my family, but only when I say yes." |
| 0:50–0:57 | Cut to a second chat: "oh no I already clicked it" → calm steps → "🕐 I'll check in with you…" → a minute later (cut) "👋 Hi Vivek, checking in…" | "And if I'd already clicked, it calms me down, gives me the steps, and checks in later." |
| 0:57–1:00 | Sage logo + "Sage · Photon × TinyFish" | "Sage. Built with Photon and TinyFish." |

**If you have a family contact set up:** in the 0:42 shot, show "Want me to warn Mom?" → yes → cut to the second phone receiving the card. It's the strongest payoff shot.

**Fallbacks:** if a check runs long, cut it. If a verdict differs from the script, keep the real one; judges value real over scripted.

## LinkedIn post (required; tag the TinyFish and Photon company pages)

> Every student I know has gotten one: a "Shopify internship" that wants your SIN by text, a "CRA refund", a $1.99 parcel fee.
>
> So I built **Sage**, an AI assistant that lives in iMessage. Text it anything that feels off (a screenshot, a link, a forward) and about a minute later it texts back a clear verdict: 🔴 Scam, 🟠 Be careful, 🟡 Can't confirm or 🟢 Looks real, with steps to follow and real sources.
>
> Under the hood:
> 📱 **Photon** Spectrum is the iMessage layer: tapbacks, a live progress bubble, link previews, and a family alert card you can forward.
> 🐟 **TinyFish** does the web work with all three endpoints: Search finds reports and the real official site, Fetch reads them, and the Agent goes onto the real website (it searched Shopify's actual careers page for the "internship").
>
> It never fakes a source, never says "safe to click", and asks before anything is sent to anyone.
>
> Built for the TinyFish Student Bounty. Demo below 👇
> @TinyFish @Photon #TinyFishStudents #AIagents #iMessage

## X post (optional per the rulebook; the bounty page asks for it, tag @Tiny_Fish and Photon)

> Got a "Shopify internship" text asking for your SIN? 🚩
>
> I built Sage: text it anything sketchy on iMessage → it checks the live web and texts back 🔴 Scam / 🟢 Looks real + steps + real sources.
>
> 📱 @photon iMessage layer
> 🐟 @Tiny_Fish Search + Fetch + Agent (searched Shopify's real careers page)
>
> 60s demo 👇

## Submission checklist

- [ ] Public GitHub repo with this README
- [ ] 60-second video posted on **LinkedIn** (tag TinyFish + Photon) and **X** (tag @Tiny_Fish + Photon)
- [ ] Posted in **#showcase** on the TinyFish Discord (repo link + video)
- [ ] tinybounties.com → My claims → **Submit build** (repo link, video links, short notes)
- [ ] Optional: keep Sage running for a day; reviewers can text it once their number is added under Users in Photon
