/**
 * The two providers' keys, set in Settings → Connections, and how each one
 * has been answering lately.
 *
 * `.env` still works (NANOGPT_API_KEY, GOOGLE_APPLICATION_CREDENTIALS,
 * GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION). What you save in Settings
 * goes in the data folder and wins over it: `providers.json` for the
 * nanoGPT key and Vertex AI's project and region, and `vertex-key.json` for
 * the service account key. Both are written readable by the server's user
 * only, and neither is ever sent back to the browser: the browser sees the
 * key's last four characters, and the key file's name and account.
 *
 * Health: every chat completion (story replies, the agent, tests) reports
 * whether the provider answered, so Settings can say "connected · 1.4 s" or
 * "key rejected" from what really happened, not from a guess.
 */

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { ValidationError } from "./errors.ts";
import type { ApiOptions } from "./nanogpt.ts";
import { forgetVertexTokens, vertexBaseUrl } from "./vertex.ts";
import type { ProviderId } from "./types.ts";

/** What's saved in providers.json. */
interface Saved {
  nanogptKey?: string;
  vertexProject?: string;
  vertexLocation?: string;
  /** The key file's name as you picked it, to show beside it. */
  vertexKeyName?: string;
}

/** How a provider answered its last request. */
export interface Health {
  ok: boolean;
  /** When (ISO). */
  at: string;
  /** How long it took to answer, in ms (when it answered). */
  ms: number | null;
  /** The HTTP status of a failure, if there was one. */
  status: number | null;
  /** What went wrong, as shown to you. */
  message: string;
  /** Failures in a row, counting this one (0 when it worked). */
  failures: number;
}

/** A provider as Settings shows it. Never carries a key. */
export interface ProviderView {
  id: ProviderId;
  /** Ready to send requests. */
  set: boolean;
  /** Where its settings come from. */
  source: "app" | "env" | "none";
  /** nanoGPT: the key's last four characters. */
  last4?: string;
  /** Vertex AI. */
  project?: string;
  location?: string;
  keyName?: string;
  /** The service account the key file belongs to. */
  account?: string;
  health: Health | null;
}

export const VERTEX_REGIONS: [string, string][] = [
  ["global", "Google picks"],
  ["us-central1", "Iowa"],
  ["us-east4", "Northern Virginia"],
  ["us-east5", "Columbus"],
  ["us-west1", "Oregon"],
  ["europe-west1", "Belgium"],
  ["europe-west4", "Netherlands"],
  ["europe-west9", "Paris"],
  ["asia-northeast1", "Tokyo"],
  ["asia-northeast3", "Seoul"],
  ["asia-southeast1", "Singapore"],
];

export class Providers {
  private saved: Saved = {};
  private readonly health = new Map<ProviderId, Health>();
  private readonly file: string;
  private readonly keyFile: string;

  /** `api` is the options object every request uses; it's updated in place when a key changes. */
  constructor(
    private readonly config: Config,
    readonly api: ApiOptions,
  ) {
    this.file = join(config.dataDir, "providers.json");
    this.keyFile = join(config.dataDir, "vertex-key.json");
    try {
      this.saved = JSON.parse(readFileSync(this.file, "utf8")) as Saved;
    } catch {
      this.saved = {};
    }
    this.apply();
    api.onResult = (provider, outcome) => this.record(provider, outcome);
  }

  /** Put the saved settings (or .env's) into the request options. */
  private apply(): void {
    this.api.apiKey = this.saved.nanogptKey || this.config.apiKey;
    const appKey = existsSync(this.keyFile);
    const keyFile = appKey ? this.keyFile : this.config.vertex.keyFile;
    const project = this.saved.vertexProject || this.config.vertex.project;
    const location = this.saved.vertexLocation || this.envLocation();
    const ready = Boolean(keyFile && project);
    this.api.vertex = { keyFile: ready ? keyFile : "", baseUrl: ready ? vertexBaseUrl(project, location) : "", project };
    forgetVertexTokens();
  }

  /** The region from .env's address ("global" when it isn't set). */
  private envLocation(): string {
    const m = /\/locations\/([^/]+)\//.exec(this.config.vertex.baseUrl);
    return m ? decodeURIComponent(m[1]!) : "global";
  }

  private write(): void {
    writeFileSync(this.file, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    chmodSync(this.file, 0o600);
    this.apply();
  }

  setNanogptKey(raw: unknown): void {
    if (typeof raw !== "string" || !raw.trim()) throw new ValidationError("Paste the API key first.");
    const key = raw.trim();
    if (/\s/.test(key) || key.length > 300) throw new ValidationError("That doesn't look like an API key: it has spaces in it, or it's very long.");
    this.saved.nanogptKey = key;
    this.health.delete("nanogpt");
    this.write();
  }

  setVertex(raw: { project?: unknown; location?: unknown; keyJson?: unknown; keyName?: unknown }): void {
    if (raw.project !== undefined) {
      if (typeof raw.project !== "string" || !/^[a-z][a-z0-9-]{4,29}$/.test(raw.project.trim())) {
        throw new ValidationError("A Google Cloud project ID is 6 to 30 lower-case letters, digits and dashes, starting with a letter.");
      }
      this.saved.vertexProject = raw.project.trim();
    }
    if (raw.location !== undefined) {
      if (typeof raw.location !== "string" || !VERTEX_REGIONS.some(([id]) => id === raw.location)) throw new ValidationError("Pick a region from the list.");
      this.saved.vertexLocation = raw.location;
    }
    if (raw.keyJson !== undefined) {
      if (typeof raw.keyJson !== "string") throw new ValidationError("The key file must be JSON text.");
      let parsed: { type?: unknown; client_email?: unknown; private_key?: unknown };
      try {
        parsed = JSON.parse(raw.keyJson);
      } catch {
        throw new ValidationError("That file isn't JSON. Download the service account key again from Google Cloud.");
      }
      if (typeof parsed?.client_email !== "string" || typeof parsed.private_key !== "string") {
        throw new ValidationError("That file isn't a service account key. In Google Cloud, open IAM > Service accounts, pick the account, and add a JSON key.");
      }
      writeFileSync(this.keyFile, raw.keyJson, { mode: 0o600 });
      chmodSync(this.keyFile, 0o600);
      this.saved.vertexKeyName = typeof raw.keyName === "string" && raw.keyName.trim() ? raw.keyName.trim().slice(0, 80) : "service-account.json";
    }
    this.health.delete("vertex");
    this.write();
  }

  /** Forget what Settings saved for a provider, so .env's applies again. */
  clear(provider: ProviderId): void {
    if (provider === "nanogpt") delete this.saved.nanogptKey;
    else {
      delete this.saved.vertexProject;
      delete this.saved.vertexLocation;
      delete this.saved.vertexKeyName;
      rmSync(this.keyFile, { force: true });
    }
    this.health.delete(provider);
    this.write();
  }

  record(provider: ProviderId, outcome: { ok: boolean; ms: number | null; status?: number | null; message?: string }): void {
    const before = this.health.get(provider);
    this.health.set(provider, {
      ok: outcome.ok,
      at: new Date().toISOString(),
      ms: outcome.ms,
      status: outcome.status ?? null,
      message: outcome.ok ? "" : (outcome.message ?? "It didn't answer."),
      failures: outcome.ok ? 0 : (before && !before.ok ? before.failures : 0) + 1,
    });
  }

  views(): Record<ProviderId, ProviderView> {
    const nanoKey = this.api.apiKey;
    const vertex = this.api.vertex!;
    let account = "";
    if (vertex.keyFile) {
      try {
        const k = JSON.parse(readFileSync(vertex.keyFile, "utf8")) as { client_email?: unknown };
        if (typeof k.client_email === "string") account = k.client_email;
      } catch {
        account = "";
      }
    }
    const appVertex = existsSync(this.keyFile) || Boolean(this.saved.vertexProject);
    return {
      nanogpt: {
        id: "nanogpt",
        set: Boolean(nanoKey),
        source: this.saved.nanogptKey ? "app" : nanoKey ? "env" : "none",
        last4: nanoKey ? nanoKey.slice(-4) : "",
        health: this.health.get("nanogpt") ?? null,
      },
      vertex: {
        id: "vertex",
        set: Boolean(vertex.keyFile && vertex.baseUrl),
        source: appVertex ? "app" : vertex.keyFile ? "env" : "none",
        project: vertex.project,
        location: this.saved.vertexLocation || this.envLocation(),
        keyName: existsSync(this.keyFile) ? (this.saved.vertexKeyName ?? "service-account.json") : vertex.keyFile ? vertex.keyFile.split("/").at(-1) : "",
        account,
        health: this.health.get("vertex") ?? null,
      },
    };
  }
}
