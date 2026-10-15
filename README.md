# Sage — "is this legit?" over iMessage

**Text Sage anything that feels off — a scam text, a sketchy email, a too-good-to-be-true internship offer, a WhatsApp forward — and it checks it against the live web and texts you back with a verdict, real sources, and how to verify it yourself.**

Built for TinyFish Student Bounty Drop 001 with **Photon Spectrum** (iMessage) + **TinyFish** (web).

---

## Who it's for

Students. We're one of the most targeted groups for scams: fake internship and job offers, rental deposits, "CRA owes you" texts, fake package fees, ticket resales. It's a moment that happens almost daily — so it's something you'd text again tomorrow.

And because the same scams hit our parents and grandparents, Sage can **warn a family member** for you (always asking first).

## What a conversation looks like

> **You:** *(screenshot of a text: "Congrats! You've been selected for a Remote Data Analyst internship at Shopify, $45/hr. Reply with your SIN to start onboarding")*
>
> **Sage:** ‼️ *(tapback)* · 🔎 On it… → 📄 Reading shopify.com… → 🧭 Checking Shopify's real careers page for this role… → ✓ Checked 6 live sources
>
> **Sage:**
> **🔴 SCAM**
> This isn't a real Shopify offer — they never ask for your SIN by text.
> **Why**
> • No "Remote Data Analyst" internship is listed on Shopify's careers page [1]
> • Shopify warns that recruiters never request personal ID numbers by text [2]
> **Do this now**
> 1. Don't reply or send your SIN
> 2. Block the number
>
> **Sage:** **Check it yourself** · Search shopify.com/careers yourself … **Sources** [1] [2]
>
> **Sage:** Want me to give Mom a heads-up so she doesn't fall for this one? (yes/no)

## How Photon and TinyFish are each used

| Layer | What it does in Sage |
|---|---|
| **Photon Spectrum** (`spectrum-ts`, cloud iMessage provider) | Receives texts, links, **screenshots and voice notes**; tapback the moment something arrives; typing indicator; a live **progress bubble edited in place** as each web step runs; markdown-styled verdicts; proactive DMs to a family contact. |
| **TinyFish Search** | Finds reports of the exact message, identifies the organisation's **real official domain**, finds its fraud-warning page, and (for forwards) finds news + fact-checks. |
| **TinyFish Fetch** | Reads the live pages: the organisation's own scam warnings, scam reports, news articles, fact-checks. The verdict is written only from these. |
| **TinyFish Agent** | Multi-step browsing on the **real** site: for job offers it opens the company's careers page and searches for the role; otherwise it navigates Help/Contact/Security pages to find the official way to report fraud and the real support number. |
| Gemini (free tier) | Reads screenshots / voice notes, works out what's being claimed, and writes the verdict **only from fetched sources**. |

**Trust rules built into the code**
- Every source shown is a page TinyFish actually searched or fetched; citation IDs are validated in code, and an official phone number is only shown if it appears on the official site.
- It never says "safe to click" — the strongest positive is "looks real, verify it this way".
- It never sends anything on your behalf without a yes (guardian invites and alerts are both confirmed first), and a family contact must opt in themselves.
- If evidence is thin it says **CAN'T CONFIRM** instead of guessing. If the web is slow or a step fails, it says so and gives safe default advice.

**Memory / right moment:** Sage remembers your name, your recent checks, your language, and your family contact. It only texts unprompted at one moment — right after a scam verdict, to offer warning your family — otherwise it stays quiet. If you later say *"I already clicked it"*, it knows what you mean and switches to calm damage-control steps.

**Also:** replies in the language you write in · understands voice notes · handles bursts ("look at this" + screenshot) as one request · caches repeat scams so a scam forwarded by 20 people is checked once · per-user daily limit and a global cap on credit-using Agent runs.

---

## Run it yourself (≈10 minutes)

**You need:** a Mac or Linux machine, [Bun](https://bun.sh), and three keys.

1. **Photon Spectrum** — create a project at [app.photon.codes](https://app.photon.codes), add an iMessage line, copy the **Project ID** and **Project Secret** from Settings.
2. **TinyFish** — create an API key at [agent.tinyfish.ai/api-keys](https://agent.tinyfish.ai/api-keys). (Search and Fetch are free; Agent uses credits.)
3. **Gemini** — free key at [aistudio.google.com](https://aistudio.google.com).

```bash
git clone <this repo> sage && cd sage
bun install
cp .env.example .env      # paste your keys into .env
bun run start             # Sage is live on your Photon iMessage line
```

**Try it without a phone:**

```bash
bun run terminal                                   # chat with Sage in your terminal
bun run check "Your CRA refund of \$428 is ready, claim at cra-refund-canada.com"
bun run check --image ./screenshot.png "is this real?"
```

**Demo mode:** set `ALLOWLIST=+1XXXXXXXXXX` in `.env` so only your test numbers get replies.

## Project layout

```
src/index.ts        Spectrum loop: debouncing, routing, onboarding, guardian flow, rate limits
src/brain.ts        Gemini: understand (text/screenshot/voice) + judge (sourced verdict)
src/investigate.ts  The web work: Search → Fetch → Agent, link-domain check, citation validation, cache
src/tinyfish.ts     TinyFish Search / Fetch / Agent wrappers with timeouts and budget caps
src/format.ts       How messages look in iMessage
src/db.ts           SQLite memory (name, language, family contact, recent checks) — no screenshots stored
scripts/check.ts    Test the pipeline from the command line
```

## Privacy

Don't send passwords or card numbers — Sage flags them and never repeats them. Screenshots are processed and discarded, not stored. Note that the Gemini free tier may use inputs to improve Google's models; use a paid key or swap the model for sensitive deployments.

---

Built by Vivek Salwan · Photon Spectrum + TinyFish
