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
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (MIGRATIONS.length > 5) MIGRATIONS.length = 5;
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
  expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(6);
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
  old.exec("DROP TABLE agent_edits; DROP TABLE agent_messages; DROP TABLE agent_sessions; DROP TABLE agent_files; PRAGMA user_version = 4");
  old.close();
  const db = openDatabase(file);
  expect(tables(db)).toEqual(expect.arrayContaining(["agent_files", "agent_sessions", "agent_messages", "agent_edits", "photos"]));
  db.close();
});
