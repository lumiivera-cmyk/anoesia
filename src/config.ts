/**
 * Server configuration, read from environment variables. Bun loads `.env`
 * from the project folder on its own (see `.env.example`).
 *
 * Only what belongs to the machine lives here: keys, the port, the data
 * folder. Everything about the chats is set in the app.
 */

import { resolve } from "node:path";
import { vertexBaseUrl, type VertexOptions } from "./vertex.ts";

export interface Config {
  host: string;
  /** Names besides localhost and IP addresses the app may be opened by (ALLOWED_HOSTS). */
  allowedHosts: string[];
  port: number;
  dataDir: string;
  publicDir: string;
  apiKey: string;
  apiBaseUrl: string;
  vertex: VertexOptions;
  requestTimeoutMs: number;
  /**
   * Running as a service on a server (ANOESIA_HOSTED=1, set in
   * deploy/anoesia.service): with no password set, nobody gets in.
   */
  hosted: boolean;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const root = resolve(import.meta.dir, "..");
  const keyFile = envText(env.GOOGLE_APPLICATION_CREDENTIALS);
  const project = envText(env.GOOGLE_CLOUD_PROJECT);
  const location = vertexLocation(env.GOOGLE_CLOUD_LOCATION);
  const vertexReady = keyFile !== "" && project !== "";
  const port = Number(env.PORT ?? 4950);
  const timeout = Number(env.REQUEST_TIMEOUT_SECONDS ?? 180);
  return {
    host: env.HOST?.trim() || "127.0.0.1",
    allowedHosts: (env.ALLOWED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    port: Number.isInteger(port) && port > 0 ? port : 4950,
    dataDir: resolve(root, env.DATA_DIR?.trim() || "data"),
    publicDir: resolve(root, "public"),
    apiKey: env.NANOGPT_API_KEY?.trim() ?? "",
    apiBaseUrl: (env.NANOGPT_BASE_URL?.trim() || "https://nano-gpt.com/api/v1").replace(/\/+$/, ""),
    vertex: {
      keyFile: vertexReady ? resolve(root, keyFile) : "",
      baseUrl: vertexReady ? vertexBaseUrl(project, location) : "",
      project,
    },
    hosted: env.ANOESIA_HOSTED === "1",
    requestTimeoutMs: (Number.isFinite(timeout) && timeout > 0 ? timeout : 180) * 1000,
  };
}

/**
 * A `.env` value with spaces and stray quotes taken off the ends. Bun drops a
 * matched pair of quotes itself, but a value copied from elsewhere can keep
 * one, like `global"`, and that ends up inside the address.
 */
export function envText(value: string | undefined): string {
  return (value ?? "").trim().replace(/^["'`]+|["'`]+$/g, "").trim();
}

/**
 * GOOGLE_CLOUD_LOCATION, cleaned: "global" or a region such as
 * `us-central1`. Anything else can't be part of an address, so it falls
 * back to "global" with a warning in the log.
 */
export function vertexLocation(value: string | undefined): string {
  const location = envText(value).toLowerCase();
  if (location === "") return "global";
  if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(location)) return location;
  console.warn(`GOOGLE_CLOUD_LOCATION in .env isn't a location (${JSON.stringify(value)}); using "global". Set it to global or a region such as us-central1.`);
  return "global";
}
