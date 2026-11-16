/**
 * Signing in to Google Vertex AI (now called "Agent Platform") with a
 * service account key. Ported from Tethera.
 *
 * Vertex's OpenAI-style endpoint takes no plain API key. Instead the key
 * file (a JSON download from Google Cloud: IAM > Service accounts > Keys)
 * signs a short note, a JWT, which Google's token address trades for an
 * access token that lasts about an hour. That token goes in the usual
 * `Authorization: Bearer ...` header.
 *
 * Tokens are kept in memory and fetched again a few minutes before they
 * run out. Nothing here ever logs or returns the key, the token, or the
 * settings from `.env` (the key file's path, the project) in an error
 * message: see `scrubVertex`.
 *
 * Signing uses the built-in `node:crypto`, so there is no SDK to install.
 */

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { ApiError } from "./nanogpt.ts";

/** What the access token lets the app do: everything on Google Cloud the service account's roles allow. */
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
/** Fetch a new token when the old one has less than this left. */
const REFRESH_EARLY_MS = 5 * 60 * 1000;

/** Where Vertex AI is, from `.env` (see `config.ts`). Both "" when it isn't set up. */
export interface VertexOptions {
  /** The absolute path to the service account key file. */
  keyFile: string;
  /** The OpenAI-style address, no trailing slash (see `vertexBaseUrl`). */
  baseUrl: string;
  /** GOOGLE_CLOUD_PROJECT, so it can be kept out of error messages. */
  project: string;
}

/**
 * Vertex's OpenAI-style address for a project and location. "global" lives
 * at `aiplatform.googleapis.com`, every other location at
 * `{location}-aiplatform.googleapis.com`.
 */
export function vertexBaseUrl(project: string, location: string): string {
  const where = location || "global";
  const host = where === "global" ? "aiplatform.googleapis.com" : `${where}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(where)}/endpoints/openapi`;
}

/** Vertex names Google's models `google/<model>`; a bare `gemini-2.5-pro` gets the prefix. */
export function vertexModel(model: string): string {
  return model.includes("/") ? model : `google/${model}`;
}

/** Whether a model id is a Gemini model, the only ones a Vertex profile may use (`gemini-...` or `google/gemini-...`). */
export function isGeminiModel(model: string): boolean {
  return /^(google\/)?gemini/i.test(model.trim());
}

/**
 * A message with the settings from `.env` taken out: the key file's path
 * and the project name, which Google's own error messages and network
 * errors (they quote the address) can carry.
 */
export function scrubVertex(message: string, vertex: Pick<VertexOptions, "keyFile" | "project">): string {
  let clean = message;
  if (vertex.keyFile) clean = clean.replaceAll(vertex.keyFile, "the key file");
  if (vertex.project) {
    clean = clean.replaceAll(encodeURIComponent(vertex.project), "your-project").replaceAll(vertex.project, "your-project");
  }
  return clean;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

const cache = new Map<string, { token: string; expiresAt: number }>();
/** Token fetches under way, so calls made together share one. */
const pending = new Map<string, Promise<string>>();

/**
 * An access token for the service account whose key file is at `keyFile`,
 * from memory while it has a while left, otherwise fresh from Google.
 */
export function vertexToken(keyFile: string, timeoutMs: number, now = Date.now()): Promise<string> {
  const kept = cache.get(keyFile);
  if (kept && kept.expiresAt - REFRESH_EARLY_MS > now) return Promise.resolve(kept.token);
  let fetching = pending.get(keyFile);
  if (!fetching) {
    fetching = fetchToken(keyFile, timeoutMs).finally(() => pending.delete(keyFile));
    pending.set(keyFile, fetching);
  }
  return fetching;
}

/** Forget every token, so the next call signs in again (for tests). */
export function forgetVertexTokens(): void {
  cache.clear();
}

function readKeyFile(keyFile: string): ServiceAccount {
  let text: string;
  try {
    text = readFileSync(keyFile, "utf8");
  } catch {
    throw new ApiError("Couldn't read the Vertex AI key file. Choose it again in Settings → Connections.");
  }
  let json: Partial<ServiceAccount> & { type?: unknown };
  try {
    json = JSON.parse(text);
  } catch {
    throw new ApiError("The Vertex AI key file isn't JSON. Download the service account key again from Google Cloud.");
  }
  if (typeof json.client_email !== "string" || typeof json.private_key !== "string") {
    throw new ApiError("The Vertex AI key file isn't a service account key. In Google Cloud, open IAM > Service accounts, pick the account, and add a JSON key.");
  }
  return { client_email: json.client_email, private_key: json.private_key, token_uri: typeof json.token_uri === "string" ? json.token_uri : DEFAULT_TOKEN_URI };
}

const base64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

async function fetchToken(keyFile: string, timeoutMs: number): Promise<string> {
  const account = readKeyFile(keyFile);
  const issued = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: account.token_uri, iat: issued, exp: issued + 3600 }));
  let signature: string;
  try {
    signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(account.private_key, "base64url");
  } catch {
    throw new ApiError("The private key in the Vertex AI key file couldn't be used. Download the service account key again from Google Cloud.");
  }

  let response: Response;
  let text: string;
  try {
    response = await fetch(account.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${claims}.${signature}` }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    throw new ApiError(`Couldn't reach Google to sign in to Vertex AI: ${(error as Error).message}`);
  }
  let json: { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown } = {};
  try {
    json = JSON.parse(text);
  } catch {
    // Read below as a failure.
  }
  if (!response.ok || typeof json.access_token !== "string") {
    // Google's own words, e.g. "invalid_grant: Invalid JWT Signature." They never hold the key or a token.
    const detail = [json.error, json.error_description].filter((v) => typeof v === "string").join(": ");
    const hint =
      json.error === "invalid_grant"
        ? "Google wouldn't sign in the Vertex AI service account. The key may have been deleted or disabled in Google Cloud (download a new one), or this phone's clock may be off."
        : `Google wouldn't sign in the Vertex AI service account (HTTP ${response.status}).`;
    throw new ApiError(detail ? `${hint} (${detail})` : hint, response.status);
  }
  const lasts = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
  cache.set(keyFile, { token: json.access_token, expiresAt: Date.now() + lasts * 1000 });
  return json.access_token;
}
