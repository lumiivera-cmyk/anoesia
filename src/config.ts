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
  const keyFile = env.GOOGLE_APPLICATION_CREDENTIALS?.trim() ?? "";
  const project = env.GOOGLE_CLOUD_PROJECT?.trim() ?? "";
  const location = env.GOOGLE_CLOUD_LOCATION?.trim() || "global";
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
