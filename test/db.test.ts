/**
 * Database upgrades: migrations 3 to 5 are reconciled by looking at the
 * schema (the agent and lacquer branches each shipped their own 3), and
 * every migration after 5 still runs exactly once.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, openDatabase } from "../src/db.ts";

const dirs: string[] = [];
/** The real migrations; tests that add one take it off again. */
const REAL = MIGRATIONS.length;
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (MIGRATIONS.length > REAL) MIGRATIONS.length = REAL;
});

function path() {
  const dir = mkdtempSync(join(tmpdir(), "anoesia-db-"));
  dirs.push(dir);
  return join(dir, "a.db");
}

const tables = (db: ReturnType<typeof openDatabase>) => (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);

test("a migration added after 5 runs, on a new database and on an existing one", () => {
  const file = path();
  openDatabase(file).close();
  MIGRATIONS.push("CREATE TABLE later_thing (x TEXT);");
  const db = openDatabase(file);
  expect(tables(db)).toContain("later_thing");
  expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(REAL + 1);
  db.close();
  // and not twice
  openDatabase(file).close();
  const fresh = openDatabase(path());
  expect(tables(fresh)).toContain("later_thing");
  fresh.close();
});

test("a database from the lacquer branch (colours and photos at 4) gets the agent tables", () => {
  const file = path();
  const old = openDatabase(file);
  old.exec("DROP TABLE agent_edits; DROP TABLE agent_messages; DROP TABLE agent_sessions; DROP TABLE agent_files; ALTER TABLE chat_cast DROP COLUMN onstage; ALTER TABLE messages DROP COLUMN reasonings; ALTER TABLE messages DROP COLUMN story; PRAGMA user_version = 4");
  old.close();
  const db = openDatabase(file);
  expect(tables(db)).toEqual(expect.arrayContaining(["agent_files", "agent_sessions", "agent_messages", "agent_edits", "photos"]));
  db.close();
});

test("a database at 5 (the agent and lacquer merged) gets the agent sessions' scope (6)", () => {
  const file = path();
  const old = openDatabase(file);
  old.exec("ALTER TABLE agent_sessions DROP COLUMN scope; ALTER TABLE chat_cast DROP COLUMN onstage; ALTER TABLE messages DROP COLUMN reasonings; ALTER TABLE messages DROP COLUMN story; PRAGMA user_version = 5");
  old.exec("INSERT INTO agent_sessions (id, title, created_at, updated_at) VALUES ('s', 'Old', 'x', 'x')");
  old.close();
  const db = openDatabase(file);
  expect((db.query("SELECT scope FROM agent_sessions WHERE id = 's'").get() as { scope: string }).scope).toBe("main");
  expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(REAL);
  db.close();
});

test("a database at 6 gets cast presence and chat notes (7), keeping its blocks", () => {
  const file = path();
  const old = openDatabase(file);
  old.exec(`
    ALTER TABLE chat_cast DROP COLUMN onstage; ALTER TABLE messages DROP COLUMN reasonings; ALTER TABLE messages DROP COLUMN story;
    DROP TABLE prompt_blocks;
    CREATE TABLE prompt_blocks (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('main', 'text', 'field', 'history')),
      card_id TEXT REFERENCES cards(id) ON DELETE CASCADE, field_id TEXT REFERENCES card_fields(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'system',
      enabled INTEGER NOT NULL DEFAULT 1, depth INTEGER, position INTEGER NOT NULL
    );
    INSERT INTO chats (id, name, created_at, updated_at) VALUES ('c', 'Old', 'x', 'x');
    INSERT INTO prompt_blocks (id, chat_id, kind, title, content, position) VALUES ('b', 'c', 'text', 'Mine', 'Kept.', 0);
    PRAGMA user_version = 6;
  `);
  old.close();
  const db = openDatabase(file);
  expect((db.query("SELECT content FROM prompt_blocks WHERE id = 'b'").get() as { content: string }).content).toBe("Kept.");
  db.exec("INSERT INTO prompt_blocks (id, chat_id, kind, title, position) VALUES ('n', 'c', 'note', 'Right now', 1)");
  expect((db.query("PRAGMA table_info(chat_cast)").all() as { name: string }[]).map((c) => c.name)).toContain("onstage");
  expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(REAL);
  db.close();
});

test("a database at 7 gets a reasoning for each reply's versions (8), older replies with none", () => {
  const file = path();
  const old = openDatabase(file);
  old.exec(`
    ALTER TABLE messages DROP COLUMN reasonings;
    ALTER TABLE messages DROP COLUMN story;
    INSERT INTO chats (id, name, created_at, updated_at) VALUES ('c', 'Old', 'x', 'x');
    INSERT INTO messages (id, chat_id, seq, role, author, swipes, created_at) VALUES ('m', 'c', 1, 'assistant', 'narrator', '["One.","Two."]', 'x');
    PRAGMA user_version = 7;
  `);
  old.close();
  const db = openDatabase(file);
  expect((db.query("SELECT reasonings FROM messages WHERE id = 'm'").get() as { reasonings: string }).reasonings).toBe("[]");
  expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(REAL);
  db.close();
});

test("a database at 8 gets a saved story for each message (9), none for older ones", () => {
  const file = path();
  const old = openDatabase(file);
  old.exec(`
    ALTER TABLE messages DROP COLUMN story;
    INSERT INTO chats (id, name, created_at, updated_at) VALUES ('c', 'Old', 'x', 'x');
    INSERT INTO messages (id, chat_id, seq, role, author, swipes, created_at) VALUES ('m', 'c', 1, 'assistant', 'narrator', '["One."]', 'x');
    PRAGMA user_version = 8;
  `);
  old.close();
  const db = openDatabase(file);
  expect((db.query("SELECT story FROM messages WHERE id = 'm'").get() as { story: string | null }).story).toBeNull();
  expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(REAL);
  db.close();
});
