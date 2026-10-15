// Quick pipeline test without iMessage:
//   bun run check "Canada Post: your parcel is on hold, pay $1.99 at cpost-redelivery.com"
//   bun run check --image ./screenshot.png "is this legit?"

import { readFileSync } from "node:fs";
import { understand, type Media } from "../src/brain";
import { investigate } from "../src/investigate";
import { verdictMessage, followupMessage, progressDone } from "../src/format";

const args = process.argv.slice(2);
const media: Media[] = [];
const imgIdx = args.indexOf("--image");
if (imgIdx >= 0) {
  const path = args[imgIdx + 1]!;
  const ext = path.split(".").pop()!.toLowerCase();
  media.push({ mimeType: ext === "png" ? "image/png" : "image/jpeg", base64: readFileSync(path).toString("base64") });
  args.splice(imgIdx, 2);
}
const text = args.join(" ");
if (!text && !media.length) {
  console.log('Usage: bun run check "suspicious message text" [--image file.png]');
  process.exit(1);
}

const t0 = Date.now();
const u = await understand({ texts: text ? [text] : [], media, userName: null, guardian: null, pending: null, history: [], recentChecks: [] });
console.log("\n── understood ──\n", JSON.stringify(u, null, 2));
if (u.intent !== "check" || !u.check) {
  console.log("\n(reply) ", u.reply);
  process.exit(0);
}
const inv = await investigate(u.check, u.language ?? "en", (l) => console.log("  …", l));
console.log(`\n── ${progressDone(inv)} (${((Date.now() - t0) / 1000).toFixed(1)}s) ──\n`);
console.log(verdictMessage(inv));
console.log("\n" + (followupMessage(inv) ?? ""));
