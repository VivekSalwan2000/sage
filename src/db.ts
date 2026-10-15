// Tiny SQLite memory layer (bun:sqlite — free, zero setup, file on disk).
// Stores only what Sage needs: a name, a family contact, short history, and check summaries.
// Raw screenshots are never stored.

import { Database } from "bun:sqlite";
import { config } from "./config";

export const db = new Database(config.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,               -- sender handle (phone/email)
  name TEXT,
  language TEXT,
  guardian_name TEXT,
  guardian_phone TEXT,
  guardian_status TEXT,              -- 'invited' | 'confirmed' | NULL
  onboarded INTEGER DEFAULT 0,
  guardian_tip_shown INTEGER DEFAULT 0,
  pending TEXT,                      -- JSON: a yes/no question Sage is waiting on
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT, role TEXT, text TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT, kind TEXT, verdict TEXT, headline TEXT, about TEXT,
  sources TEXT,                      -- JSON array of cited URLs, shown when the user replies "links"
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY, value TEXT, created_at INTEGER DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS usage (
  day TEXT, key TEXT, count INTEGER DEFAULT 0, PRIMARY KEY (day, key)
);
`);

// Migration for databases created before the sources column existed.
const checkCols = db.query("PRAGMA table_info(checks)").all() as { name: string }[];
if (!checkCols.some((c) => c.name === "sources")) db.exec("ALTER TABLE checks ADD COLUMN sources TEXT");

export type Pending =
  | { type: "guardian_alert"; checkId: number; summary: string }
  | { type: "confirm_guardian"; name: string; phone: string }
  | { type: "retry_check"; check: unknown; language: string }; // a check that failed; "try again" re-runs it

export interface User {
  id: string;
  name: string | null;
  language: string | null;
  guardian_name: string | null;
  guardian_phone: string | null;
  guardian_status: string | null;
  onboarded: number;
  guardian_tip_shown: number;
  pending: string | null;
}

export function getUser(id: string): User {
  db.query("INSERT OR IGNORE INTO users (id) VALUES (?)").run(id);
  return db.query("SELECT * FROM users WHERE id = ?").get(id) as User;
}

export function updateUser(id: string, fields: Partial<Omit<User, "id">>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  db.query(`UPDATE users SET ${sets} WHERE id = ?`).run(...(keys.map((k) => (fields as any)[k]) as any[]), id);
}

export function getPending(u: User): Pending | null {
  try {
    return u.pending ? (JSON.parse(u.pending) as Pending) : null;
  } catch {
    return null;
  }
}
export function setPending(id: string, p: Pending | null) {
  updateUser(id, { pending: p ? JSON.stringify(p) : null });
}

export function findUserByGuardianPhone(phone: string): User | null {
  return (db.query("SELECT * FROM users WHERE guardian_phone = ? AND guardian_status = 'invited' ORDER BY created_at DESC").get(phone) as User) ?? null;
}

export function addTurn(userId: string, role: "user" | "sage", text: string) {
  db.query("INSERT INTO turns (user_id, role, text) VALUES (?, ?, ?)").run(userId, role, text.slice(0, 1500));
}
export function recentTurns(userId: string, limit = 10): { role: string; text: string }[] {
  const rows = db.query("SELECT role, text FROM turns WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(userId, limit) as any[];
  return rows.reverse();
}

export function saveCheck(userId: string, kind: string, verdict: string, headline: string, about: string, sources: string[] = []): number {
  const r = db
    .query("INSERT INTO checks (user_id, kind, verdict, headline, about, sources) VALUES (?, ?, ?, ?, ?, ?)")
    .run(userId, kind, verdict, headline, about, JSON.stringify(sources));
  return Number(r.lastInsertRowid);
}
/** Cited URLs of the user's most recent check (for "links"). */
export function lastCheckSources(userId: string): string[] {
  const row = db.query("SELECT sources FROM checks WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(userId) as any;
  try {
    return row?.sources ? (JSON.parse(row.sources) as string[]) : [];
  } catch {
    return [];
  }
}
export function recentChecks(userId: string, limit = 3) {
  return db.query("SELECT kind, verdict, headline, about, created_at FROM checks WHERE user_id = ? ORDER BY id DESC LIMIT ?").all(userId, limit) as any[];
}

export function cacheGet<T>(key: string, maxAgeHours: number): T | null {
  const row = db.query("SELECT value, created_at FROM cache WHERE key = ?").get(key) as any;
  if (!row) return null;
  if (Date.now() / 1000 - row.created_at > maxAgeHours * 3600) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}
export function cacheSet(key: string, value: unknown) {
  db.query("INSERT OR REPLACE INTO cache (key, value, created_at) VALUES (?, ?, unixepoch())").run(key, JSON.stringify(value));
}

const today = () => new Date().toISOString().slice(0, 10);
export function usageGet(key: string): number {
  const row = db.query("SELECT count FROM usage WHERE day = ? AND key = ?").get(today(), key) as any;
  return row?.count ?? 0;
}
export function usageInc(key: string) {
  db.query("INSERT INTO usage (day, key, count) VALUES (?, ?, 1) ON CONFLICT(day, key) DO UPDATE SET count = count + 1").run(today(), key);
}
