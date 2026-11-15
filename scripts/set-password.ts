/**
 * Set Anoesia's password, which turns the login on (src/login.ts). For a
 * server on the internet (docs/hosting.md); on your own phone you don't
 * need one.
 *
 *   bun run set-password          asks for the new password (twice)
 *   echo "…" | bun run set-password   reads it from the input (the installer does this)
 *   bun run set-password --off    removes the password: no login again
 *
 * Setting a new password logs every device out. The server reads the
 * password when it starts, so restart it afterwards (on a server set up by
 * deploy/anoesia.service: `systemctl restart anoesia`; the script does it if
 * it can).
 */

import { loadConfig } from "../src/config.ts";
import { Login, MIN_PASSWORD } from "../src/login.ts";

const config = loadConfig();
const login = new Login(config.dataDir);

if (process.argv.includes("--off")) {
  login.remove();
  console.log("The password is removed: Anoesia no longer asks to log in. Restart it to use that.");
  restartIfService();
  process.exit(0);
}

let password: string;
if (process.stdin.isTTY) {
  const first = await ask("New password: ");
  const second = await ask("Same password again: ");
  if (first !== second) {
    console.error("Those two didn't match. Nothing was changed.");
    process.exit(1);
  }
  password = first;
} else {
  password = (await Bun.stdin.text()).replace(/\r?\n$/, "");
}

if (password.length < MIN_PASSWORD) {
  console.error(`The password needs at least ${MIN_PASSWORD} characters. Nothing was changed.`);
  process.exit(1);
}
await login.setPassword(password);
console.log("Password set. Every device that was logged in has to log in again.");
restartIfService();

/** Read a line without showing what's typed. */
async function ask(question: string): Promise<string> {
  process.stdout.write(question);
  Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
  try {
    for await (const line of console) return line;
    return "";
  } finally {
    Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
    process.stdout.write("\n");
  }
}

/** On a server running deploy/anoesia.service, restart Anoesia so it uses the change. */
function restartIfService(): void {
  if (process.getuid?.() !== 0 || !Bun.which("systemctl")) return;
  const active = Bun.spawnSync(["systemctl", "is-active", "--quiet", "anoesia"]);
  if (active.exitCode !== 0) return;
  Bun.spawnSync(["systemctl", "restart", "anoesia"]);
  console.log("Restarted Anoesia.");
}
