/**
 * Errors with a meaning the server understands, so it can answer with the
 * right status (see `src/server.ts`). Lifted from Amaedori.
 */

/** Something was looked up by an id that doesn't exist. */
export class NotFoundError extends Error {
  constructor(what: string) {
    super(`That ${what} doesn't exist.`);
    this.name = "NotFoundError";
  }
}

/** A request had invalid data. The message says what's wrong and is shown to you. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** A short random id, e.g. `k3j9x2m1q8`. */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("") + Date.now().toString(36).slice(-2);
}
