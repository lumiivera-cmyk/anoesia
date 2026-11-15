/**
 * Macros: `{{name}}` and `{{name::arg::arg}}` in any block or message,
 * filled in when the prompt is put together.
 *
 * Names and syntax follow Lumiverse's (src/macros/definitions in
 * prolix-oc/Lumiverse), so cards written for it keep working. The v1 core
 * set:
 *
 *   names       {{user}} {{char}} ({{charName}}) {{cast}} ({{group}})
 *   chat        {{lastMessage}} {{lastUserMessage}} {{lastCharMessage}} {{messageCount}}
 *   time        {{date}} {{time}} {{weekday}} {{isodate}} {{isotime}}
 *   random      {{random::a::b}} {{random::1::10}} {{pick::a::b}} {{roll::2d6}}
 *   variables   {{setvar::k::v}} {{getvar::k}} {{addvar::k::n}} {{incvar::k}} {{decvar::k}}
 *               {{hasvar::k}} {{deletevar::k}}, and the same with gvar for global ones
 *   text        {{newline}} {{space}} {{noop}} {{// comment}} {{comment::…}}
 *
 * Arguments are split on `::`. The older forms `{{roll:2d6}}`,
 * `{{roll 2d6}}` and `{{random:a,b,c}}` work too. Unknown macros are left
 * as they are, so they show in the preview. Nested macros in arguments are
 * filled first (`{{setvar::mood::{{pick::calm::tense}}}}`).
 */

export interface MacroEnv {
  user: string;
  char: string;
  cast: string[];
  lastMessage: string;
  lastUserMessage: string;
  lastCharMessage: string;
  messageCount: number;
  now: Date;
  /** This chat's variables. Changed in place by setvar and friends. */
  vars: Record<string, string>;
  /** Variables shared by every chat. Changed in place. */
  globals: Record<string, string>;
  /** A number from 0 (inclusive) to 1, like Math.random (tests pass their own). */
  random?: () => number;
}

/** A name list the way people write it: "Rumi, Mira and Zoey". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Every macro name this file knows, lowercased (aliases included), for the editor to tell known from unknown. */
export const KNOWN_MACROS = [
  "user", "char", "charname", "cast", "group",
  "lastmessage", "last_message", "lastusermessage", "last_user_message", "lastcharmessage", "last_char_message", "lastbotmessage", "messagecount", "message_count",
  "date", "time", "weekday", "isodate", "isotime",
  "random", "pick", "roll",
  "setvar", "getvar", "addvar", "incvar", "decvar", "hasvar", "varexists", "deletevar", "flushvar",
  "setgvar", "setglobalvar", "getgvar", "getglobalvar", "addgvar", "addglobalvar", "incgvar", "incglobalvar", "decgvar", "decglobalvar", "hasgvar", "hasglobalvar", "gvarexists", "deletegvar", "flushgvar", "deleteglobalvar", "flushglobalvar",
  "newline", "nl", "n", "space", "noop", "comment", "note", "//",
];

/**
 * Fill every macro in `text`, left to right, so a `{{setvar}}` is seen by a
 * `{{getvar}}` after it. A macro's arguments are filled before the macro.
 */
export function fillMacros(text: string, env: MacroEnv): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{{", i);
    if (open < 0) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, open);
    const close = matchingClose(text, open);
    if (close < 0) {
      // No closing braces: plain text.
      out += text.slice(open);
      break;
    }
    const raw = text.slice(open + 2, close);
    // Comments aren't filled: anything inside them goes.
    if (raw.trim().startsWith("//")) {
      i = close + 2;
      continue;
    }
    const inner = fillMacros(raw, env);
    const value = evaluate(inner, env);
    out += value ?? `{{${inner}}}`;
    i = close + 2;
  }
  return out;
}

/** Where the `}}` closing the `{{` at `open` is, counting nested pairs; -1 if none. */
function matchingClose(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length - 1; i++) {
    if (text[i] === "{" && text[i + 1] === "{") {
      depth++;
      i++;
    } else if (text[i] === "}" && text[i + 1] === "}") {
      depth--;
      if (depth === 0) return i;
      i++;
    }
  }
  return -1;
}

/** One macro's value, or null when it isn't one this file knows. */
function evaluate(inner: string, env: MacroEnv): string | null {
  const trimmed = inner.trim();
  if (trimmed.startsWith("//")) return "";
  const { name, args } = split(trimmed);
  const rnd = env.random ?? Math.random;
  const num = (v: string | undefined) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const varOp = (store: Record<string, string>, op: string): string => {
    const key = (args[0] ?? "").trim();
    switch (op) {
      case "set":
        store[key] = args.slice(1).join("::");
        return "";
      case "get":
        return store[key] ?? "";
      case "add": {
        const current = store[key];
        const add = args[1] ?? "";
        // Numbers add; anything else appends.
        store[key] = current !== undefined && current.trim() !== "" && !isNaN(Number(current)) && !isNaN(Number(add)) ? String(Number(current) + Number(add)) : (current ?? "") + add;
        return "";
      }
      case "inc":
        store[key] = String(num(store[key]) + 1);
        return "";
      case "dec":
        store[key] = String(num(store[key]) - 1);
        return "";
      case "has":
        return key in store ? "true" : "false";
      case "delete":
        delete store[key];
        return "";
    }
    return "";
  };

  switch (name.toLowerCase()) {
    case "user":
      return env.user;
    case "char":
    case "charname":
      return env.char;
    case "cast":
    case "group":
      return listNames(env.cast);
    case "lastmessage":
    case "last_message":
      return env.lastMessage;
    case "lastusermessage":
    case "last_user_message":
      return env.lastUserMessage;
    case "lastcharmessage":
    case "last_char_message":
    case "lastbotmessage":
      return env.lastCharMessage;
    case "messagecount":
    case "message_count":
      return String(env.messageCount);
    case "date":
      return env.now.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    case "time":
      return env.now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    case "weekday":
      return env.now.toLocaleDateString("en-US", { weekday: "long" });
    case "isodate":
      return `${env.now.getFullYear()}-${String(env.now.getMonth() + 1).padStart(2, "0")}-${String(env.now.getDate()).padStart(2, "0")}`;
    case "isotime":
      return `${String(env.now.getHours()).padStart(2, "0")}:${String(env.now.getMinutes()).padStart(2, "0")}`;
    case "random": {
      if (args.length === 0) return String(Math.round(rnd()));
      const items = args.length === 1 ? args[0]!.split(",") : args;
      if (items.length <= 2 && items.every((a) => a.trim() !== "" && !isNaN(Number(a)))) {
        const min = parseInt(items[0]!, 10) || 0;
        const max = parseInt(items[1] ?? "1", 10) || 1;
        return max < min ? String(min) : String(Math.floor(rnd() * (max - min + 1)) + min);
      }
      return items[Math.floor(rnd() * items.length)]!.trim();
    }
    case "pick": {
      const items = args.length === 1 ? args[0]!.split(",") : args;
      return items.length ? items[Math.floor(rnd() * items.length)]!.trim() : "";
    }
    case "roll": {
      const match = /^(\d*)d(\d+)$/i.exec((args[0] ?? "1d6").trim());
      if (!match) return "0";
      const count = Math.min(parseInt(match[1] || "1", 10), 100);
      const sides = parseInt(match[2]!, 10);
      if (count < 1 || sides < 1) return "0";
      let total = 0;
      for (let i = 0; i < count; i++) total += Math.floor(rnd() * sides) + 1;
      return String(total);
    }
    case "setvar":
      return varOp(env.vars, "set");
    case "getvar":
      return varOp(env.vars, "get");
    case "addvar":
      return varOp(env.vars, "add");
    case "incvar":
      return varOp(env.vars, "inc");
    case "decvar":
      return varOp(env.vars, "dec");
    case "hasvar":
    case "varexists":
      return varOp(env.vars, "has");
    case "deletevar":
    case "flushvar":
      return varOp(env.vars, "delete");
    case "setgvar":
    case "setglobalvar":
      return varOp(env.globals, "set");
    case "getgvar":
    case "getglobalvar":
      return varOp(env.globals, "get");
    case "addgvar":
    case "addglobalvar":
      return varOp(env.globals, "add");
    case "incgvar":
    case "incglobalvar":
      return varOp(env.globals, "inc");
    case "decgvar":
    case "decglobalvar":
      return varOp(env.globals, "dec");
    case "hasgvar":
    case "hasglobalvar":
    case "gvarexists":
      return varOp(env.globals, "has");
    case "deletegvar":
    case "flushgvar":
    case "deleteglobalvar":
    case "flushglobalvar":
      return varOp(env.globals, "delete");
    case "newline":
    case "nl":
    case "n":
      return "\n";
    case "space":
      return " ";
    case "noop":
    case "comment":
    case "note":
      return "";
    default:
      return null;
  }
}

/** `name::a::b`, `name:a`, or `name a` into a name and its arguments. */
function split(inner: string): { name: string; args: string[] } {
  if (inner.includes("::")) {
    const [name, ...args] = inner.split("::");
    return { name: name!.trim(), args };
  }
  const colon = /^([\w/]+):(.*)$/s.exec(inner);
  if (colon) return { name: colon[1]!, args: [colon[2]!] };
  const space = /^([\w/]+)\s+(.+)$/s.exec(inner);
  if (space) return { name: space[1]!, args: [space[2]!] };
  return { name: inner, args: [] };
}
