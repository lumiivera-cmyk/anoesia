/**
 * The login, for when Anoesia is on a server you reach over the internet
 * (docs/hosting.md). Lifted from Anoesia.
 *
 * On your own phone, the server only answers that phone, so there's no
 * password. On a server anyone can find the address, so once a password is
 * set (`bun run set-password`), every page and every API call needs you to
 * be logged in, except the login page itself and the app's icon and
 * manifest (so a phone can add it to the home screen).
 *
 * Everything lives in one file, `<data>/login.json`:
 *
 *   - the password, only as an Argon2id hash (never the password itself);
 *   - the devices that are logged in, each only as a SHA-256 of its token,
 *     so the file alone can't be used to log in.
 *
 * Logging in gives the browser a random token in a cookie that scripts on
 * the page can't read (HttpOnly), sent only to this site (SameSite=Lax), and
 * only over HTTPS when the site is on HTTPS (Secure). It lasts a year from
 * when it was last used, so the home-screen app stays logged in.
 *
 * The server reads the file when it starts, so after `bun run set-password`
 * it needs a restart (the script says so, and does it on a server).
 *
 * Wrong passwords are slowed down: after 8 wrong tries from one address in
 * 15 minutes, that address has to wait out the rest of the 15 minutes; and
 * after 40 from anywhere, everyone does (so a crowd of addresses can't keep
 * guessing). Setting a new password logs every device out.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The cookie's name. */
export const COOKIE = "anoesia_login";
/** How long a device stays logged in after it was last used (ms). */
export const SESSION_MS = 365 * 24 * 60 * 60 * 1000;
/** The shortest password allowed. */
export const MIN_PASSWORD = 10;
/** Wrong tries allowed per address, and from everywhere, in one window. */
export const MAX_FAILS_PER_ADDRESS = 8;
export const MAX_FAILS_TOTAL = 40;
export const FAIL_WINDOW_MS = 15 * 60 * 1000;
/** How often a device's "last used" is written down (so it isn't on every request). */
const TOUCH_MS = 24 * 60 * 60 * 1000;

interface Session {
  /** SHA-256 of the token, hex. */
  id: string;
  createdAt: number;
  lastUsedAt: number;
  /** The browser it was made in, cut short: so you can tell devices apart. */
  device: string;
}

interface LoginFile {
  hash: string;
  sessions: Session[];
}

export type LoginResult = { ok: true; token: string } | { ok: false; status: 401 | 429; error: string };

export class Login {
  private readonly path: string;
  private data: LoginFile | null = null;
  private readonly fails = new Map<string, number[]>();

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.path = join(dataDir, "login.json");
    this.load();
  }

  /** Whether a password is set, which turns the login on. */
  enabled(): boolean {
    return this.data !== null;
  }

  /** Set (or change) the password. Every device is logged out. */
  async setPassword(password: string): Promise<void> {
    if (password.length < MIN_PASSWORD) throw new Error(`The password needs at least ${MIN_PASSWORD} characters.`);
    const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
    this.data = { hash, sessions: [] };
    this.save();
  }

  /** Turn the login off (back to no password, for a phone-only setup). */
  remove(): void {
    rmSync(this.path, { force: true });
    this.data = null;
  }

  /** Check a password, and if it's right, start a session. */
  async logIn(password: string, address: string, device: string): Promise<LoginResult> {
    if (!this.data) return { ok: false, status: 401, error: "No password is set." };
    const wait = this.waitFor(address);
    if (wait > 0) {
      const minutes = Math.ceil(wait / 60_000);
      return { ok: false, status: 429, error: `Too many wrong tries. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` };
    }
    const right = typeof password === "string" && password.length > 0 && password.length <= 1024 && (await Bun.password.verify(password, this.data.hash));
    if (!right) {
      this.fail(address);
      return { ok: false, status: 401, error: "That isn't the password." };
    }
    const token = randomBytes(32).toString("base64url");
    const at = this.now();
    this.data.sessions = this.data.sessions.filter((s) => at - s.lastUsedAt < SESSION_MS);
    this.data.sessions.push({ id: digest(token), createdAt: at, lastUsedAt: at, device: device.slice(0, 160) });
    this.save();
    return { ok: true, token };
  }

  /** Whether a token belongs to a device that's logged in. */
  check(token: string | null): boolean {
    if (!this.data || !token) return false;
    const id = digest(token);
    const session = this.data.sessions.find((s) => same(s.id, id));
    if (!session) return false;
    const at = this.now();
    if (at - session.lastUsedAt >= SESSION_MS) return false;
    if (at - session.lastUsedAt >= TOUCH_MS) {
      session.lastUsedAt = at;
      this.save();
    }
    return true;
  }

  /** Log one device out. */
  logOut(token: string | null): void {
    if (!this.data || !token) return;
    const id = digest(token);
    this.data.sessions = this.data.sessions.filter((s) => !same(s.id, id));
    this.save();
  }

  /** Log every device out (the password stays). */
  logOutEverywhere(): void {
    if (!this.data) return;
    this.data.sessions = [];
    this.save();
  }

  /** How many devices are logged in. */
  devices(): number {
    const at = this.now();
    return this.data?.sessions.filter((s) => at - s.lastUsedAt < SESSION_MS).length ?? 0;
  }

  /** How long (ms) an address must wait before trying again: 0 if it needn't. */
  private waitFor(address: string): number {
    const at = this.now();
    const recent = (list: number[]) => list.filter((t) => at - t < FAIL_WINDOW_MS);
    let total: number[] = [];
    for (const [key, list] of this.fails) {
      const kept = recent(list);
      if (kept.length) this.fails.set(key, kept);
      else this.fails.delete(key);
      total = total.concat(kept);
    }
    const mine = this.fails.get(address) ?? [];
    const until = (list: number[], max: number) => (list.length >= max ? Math.min(...list) + FAIL_WINDOW_MS - at : 0);
    return Math.max(until(mine, MAX_FAILS_PER_ADDRESS), until(total, MAX_FAILS_TOTAL));
  }

  private fail(address: string): void {
    const list = this.fails.get(address) ?? [];
    list.push(this.now());
    this.fails.set(address, list);
  }

  private load(): void {
    if (!existsSync(this.path)) {
      this.data = null;
      return;
    }
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<LoginFile>;
    if (typeof parsed.hash !== "string" || !parsed.hash) throw new Error(`${this.path} has no password hash. Run \`bun run set-password\` again.`);
    this.data = { hash: parsed.hash, sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [] };
  }

  private save(): void {
    if (!this.data) return;
    mkdirSync(join(this.path, ".."), { recursive: true });
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(temp, this.path);
  }
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function same(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** The login token in a request's cookies, or `null`. */
export function tokenOf(request: Request): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=") || null;
  }
  return null;
}

/** Whether the request came over HTTPS (directly, or through Caddy in front). */
export function overHttps(request: Request): boolean {
  return new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
}

/** The Set-Cookie header for a new token, or for clearing it (`null`). */
export function cookieFor(token: string | null, secure: boolean): string {
  const parts = [`${COOKIE}=${token ?? ""}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${token ? SESSION_MS / 1000 : 0}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Who's asking, for counting wrong tries: the address Caddy saw (it sets
 * X-Forwarded-For to the real one), or the server's own view.
 */
export function addressOf(request: Request, direct?: string | null): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || direct || "local";
}

/**
 * The paths that work without logging in: the login page and what it uses,
 * and what a phone reads to add the app to the home screen.
 */
export function isPublicPath(path: string): boolean {
  return path === "/login" || path === "/api/login" || path === "/manifest.webmanifest" || path === "/sw.js" || path === "/icon.svg" || /^\/icons\/[\w.-]+\.png$/.test(path) || path === "/favicon.ico";
}
