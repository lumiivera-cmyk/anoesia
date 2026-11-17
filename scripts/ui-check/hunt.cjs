// The handoff's bug hunt, ported to the running app.
const { chromium } = require("playwright");
const { execSync, spawn } = require("child_process");
const fs = require("fs");
const DIR = __dirname, OUT = process.env.OUT || "/tmp/anoesia-ui-check";
fs.mkdirSync(OUT, { recursive: true });
const SCAN = fs.readFileSync(`${DIR}/layout-scan.js`, "utf8");
const AXE = process.env.AXE || "/tmp/axe/package/axe.min.js";
const BASE = "http://127.0.0.1:4950/";
let server;
async function restart() {
  if (server) { server.kill(); await new Promise((r) => server.on("exit", r)); }
  server = spawn("bun", ["run", `${DIR}/dev.ts`], { env: { ...process.env, DELAY: "150" }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((r) => server.stdout.on("data", (d) => String(d).includes("ready") && r()));
}
const home = async (p) => { if (!p.url().startsWith(BASE)) { await p.goto(BASE); await p.waitForTimeout(300); } };
const chatId = async (p, name) => (await home(p), p.evaluate(async (n) => (await (await fetch("http://127.0.0.1:4950/api/state")).json()).chats.find((c) => c.name === n).id, name));
const cardId = async (p, name) => (await home(p), p.evaluate(async (n) => (await (await fetch("http://127.0.0.1:4950/api/state")).json()).cards.find((c) => c.name.startsWith(n)).id, name));
const nav = async (p, h) => { await p.goto(BASE + h); await p.waitForTimeout(900); };
const click = async (p, sel) => { await p.locator(sel).first().click(); await p.waitForTimeout(400); };
const chat = (n) => async (p) => nav(p, "#/chat/" + (await chatId(p, n)));
const card = (n) => async (p) => nav(p, "#/cards/" + (await cardId(p, n)));
const then = (a, ...fs) => async (p) => { await a(p); for (const f of fs) await f(p); };
const tap = (sel) => (p) => click(p, sel);
const prompts = async (p) => { await chat("Backstage")(p); await nav(p, "#/prompts"); };
// Settings: a page of its own. Some screens need the server put in a state first.
const send = (method, path, body) => async (p) => { await home(p); await p.evaluate(async ([m, u, b]) => { await fetch(u, { method: m, headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }); }, [method, "http://127.0.0.1:4950" + path, body]); await p.reload(); await p.waitForTimeout(300); };
const settings = (h = "") => then(chat("Backstage"), async (p) => nav(p, "#/settings" + h));
const failingKey = then(send("PUT", "/api/providers/nanogpt", { key: "bad" }), send("POST", "/api/providers/nanogpt/test", {}));
const editor = then(settings("/connections"), tap(".prof"));
const SETTINGS = (phone) => [
  [phone ? "settings sections" : "settings", settings()],
  ["settings connections", settings("/connections")],
  ["settings failing", then(failingKey, settings("/connections"))],
  ["settings fix the key", then(failingKey, settings("/connections"), tap("[data-fix]"))],
  ["settings vertex setup", then(settings("/connections"), tap('[data-setup="vertex"]'))],
  ["settings region menu", then(settings("/connections"), tap('[data-setup="vertex"]'), tap("#vreg-b"))],
  ["settings story menu", then(settings("/connections"), tap('[data-assign="story"]'))],
  ["settings profile", editor],
  ["settings profile more", then(editor, tap("[data-more]"))],
  ["settings new profile", then(settings("/connections"), tap("[data-new-profile]"))],
  ["settings picking a model", then(editor, tap("#model-b"))],
  ["settings look", settings("/look")],
  ["settings look below readable", then(send("PATCH", "/api/settings", { background: { dim: 0.1, window: 0.4 } }), settings("/look"))],
  ["settings agent", settings("/agent")],
  ["settings typing", settings("/typing")],
];
const LACQUER = {
  desk: [
    ["chat", chat("Backstage")],
    ["chat empty", chat("Night market")],
    ["chat settings", then(chat("Backstage"), tap("#open-chat-settings"))],
    ["settings from the sidebar", then(chat("Backstage"), tap('#side a[href="#/settings"]'))],
    ["agent", then(chat("Backstage"), tap("#open-agent"))],
    ...SETTINGS(false),
    ["prompts", prompts],
    ["prompts sent", then(prompts, tap("#pv-sent"))],
    ["prompts move menu", then(prompts, tap("#block-list .bumps"))],
    ["prompts editing", then(prompts, tap("#block-list [data-toggle]"), tap("#block-list [data-edit]"))],
    ["cards", card("Ada")],
    ["cards add field", then(card("Ada"), tap("[data-add-field]"))],
    ["cards colour", then(card("Ada"), tap("[data-colour=custom]"))],
    ["cards delete", then(card("Ada"), tap("[data-delete-card]"))],
    ["cards import", then(card("Ada"), tap("#open-import"))],
  ],
  phone: [
    ["chat", chat("Backstage")],
    ["chat empty", chat("Night market")],
    ["drawer", then(chat("Backstage"), tap("#open-drawer"))],
    ["chat menu", then(chat("Backstage"), tap("#open-chat-menu"))],
    ["message menu", then(chat("Backstage"), tap("#messages .msg:last-of-type .msg-body"))],
    ["chat settings", then(chat("Backstage"), tap("#phone-title"))],
    ["settings from the drawer", then(chat("Backstage"), tap("#open-drawer"), tap('#drawer a[href="#/settings"]'))],
    ["agent", then(chat("Backstage"), tap("#open-agent-phone"))],
    ...SETTINGS(true),
    ["prompts", prompts],
    ["prompts preview", then(prompts, tap("#tab-preview"))],
    ["prompts move menu", then(prompts, tap("#block-list .bumps"))],
    ["prompts editing", then(prompts, tap("#block-list [data-toggle]"), tap("#block-list [data-edit]"))],
    ["cards library", async (p) => nav(p, "#/cards")],
    ["card", card("Ada")],
    ["card colour", then(card("Ada"), tap("[data-colour=custom]"))],
    ["card delete", then(card("Ada"), tap("[data-delete-card]"))],
  ],
};
// Every screen twice: in lacquer, and in selenite (your material set to selenite first).
const toSelenite = ([n, f]) => [`selenite ${n}`, then(send("PATCH", "/api/settings", { background: { material: "selenite" } }), f)];
const SCREENS = Object.fromEntries(Object.entries(LACQUER).map(([dev, list]) => [dev, [...list, ...list.map(toSelenite)]]));
const VP = { desk: { viewport: { width: 1440, height: 900 } }, phone: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } };
const CONTROLS = `() => {
  const top = [...document.querySelectorAll("dialog[open]")].pop();
  const root = top || document.body;
  const shown = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width >= 1 && r.height >= 1 && cs.visibility !== "hidden" && !el.closest("[inert]"); };
  return [...root.querySelectorAll('button, a[href], [role=switch], [role=tab], [role=menuitem], [role=menuitemradio], [role=radio], input[type=checkbox], input[type=radio], summary')].map((el, i) => [i, el]).filter(([, el]) => shown(el) && !(top == null && el.closest("dialog")))
    .map(([i, el]) => (el.dataset.huntI = i, [i, (el.getAttribute("aria-label") || el.innerText || el.tagName).trim().replace(/\\s+/g, " ").slice(0, 50)]));
}`;
const SNAP = `() => document.body.innerHTML.replace(/ data-hunt-i="\\d+"/g, "") + location.hash + [...document.querySelectorAll("dialog[open]")].map((d) => d.id).join()`;
const TEXTS = `() => { const out = [];
  const effOp = (el) => { let o = 1; for (let a = el; a && a !== document.documentElement; a = a.parentElement) o *= +getComputedStyle(a).opacity; return o; };
  const clipped = (el) => { for (let a = el; a && a !== document.documentElement; a = a.parentElement) if (getComputedStyle(a).clipPath !== "none") return true; return false; };
  const top = [...document.querySelectorAll("dialog[open]")].pop();
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('.sr') || el.closest('[aria-hidden="true"]') || (top && !top.contains(el)) || clipped(el)) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()); if (!own.length) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const rg = document.createRange(); rg.selectNodeContents(own[0]); const r = rg.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    // text scrolled out of its scroll area isn't on screen, whatever its box says
    let hiddenByScroll = false;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const ac = getComputedStyle(a); if (ac.overflowX === "visible" && ac.overflowY === "visible") continue; const ar = a.getBoundingClientRect(); if (r.bottom <= ar.top + 1 || r.top >= ar.bottom - 1 || r.right <= ar.left + 1 || r.left >= ar.right - 1) { hiddenByScroll = true; break; } }
    if (hiddenByScroll) continue;
    const m = cs.color.match(/[\\d.]+/g).map(Number);
    out.push({ t: own.map((n) => n.textContent).join(' ').trim().replace(/\\s+/g, ' ').slice(0, 40), x: r.left, y: r.top, w: r.width, h: r.height, c: m.slice(0, 3), a: (m.length > 3 ? m[3] : 1) * effOp(el), fs: parseFloat(cs.fontSize), fw: +cs.fontWeight, tag: el.tagName.toLowerCase(), disabled: !!el.closest(':disabled,[aria-disabled="true"]') });
  } return out; }`;
(async () => {
  const only = process.argv.slice(2);
  const noClicks = process.env.NOCLICK === "1";
  const b = await chromium.launch();
  const results = {};
  for (const [dev, screens] of Object.entries(SCREENS)) for (const [name, setup] of screens) {
    const key = `${dev} ${name}`;
    if (only.length && !only.some((o) => key.includes(o))) continue;
    await restart();
    const ctx = await b.newContext({ ...VP[dev], permissions: ["clipboard-read", "clipboard-write"] });
    const p = await ctx.newPage();
    const errs = [];
    p.on("pageerror", (e) => errs.push("pageerror: " + e.message.slice(0, 200)));
    p.on("console", (m) => m.type() === "error" && errs.push("console: " + m.text().slice(0, 200)));
    let setupErr = null;
    try { await setup(p); } catch (e) { setupErr = String(e).split("\n")[0]; }
    // selenite plates paint in a worker: measure once they're up (the click test doesn't need them)
    await p.waitForFunction(() => !document.querySelector(".plate.pending:not([hidden])"), null, { timeout: 30000 }).catch(() => errs.push("plates still painting after 30 s"));
    const r = { errors: [...errs], setupErr };
    await p.addScriptTag({ path: AXE });
    r.axe = await p.evaluate(async () => { const top = [...document.querySelectorAll("dialog[open]")].pop();
      const res = await axe.run(top || document, { resultTypes: ["violations"] });
      return res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, count: v.nodes.length, nodes: v.nodes.slice(0, 4).map((n) => ({ t: n.target.join(" "), html: n.html.slice(0, 140), why: (n.failureSummary || "").split("\n").slice(1, 2).join(" ").slice(0, 200) })) })); });
    r.layout = await p.evaluate(eval(SCAN));
    const slug = key.replace(/\W+/g, "-");
    r.texts = await p.evaluate(eval(TEXTS));
    await p.screenshot({ path: `${OUT}/${slug}-A.png` });
    await p.addStyleTag({ content: "body *{color:transparent!important;text-shadow:none!important;-webkit-text-fill-color:transparent!important;caret-color:transparent!important;text-decoration-color:transparent!important}input::placeholder,textarea::placeholder{color:transparent!important}" });
    await p.waitForTimeout(150);
    await p.screenshot({ path: `${OUT}/${slug}-B.png` });
    r.clicks = [];
    if (!noClicks && !setupErr) {
      const controls = await (async () => { await p.reload(); await p.waitForTimeout(300); await setup(p); return p.evaluate(eval(CONTROLS)); })();
      const seen = new Set();
      let dirty = true;
      p.on("request", (q) => { if (q.method() !== "GET" && q.url().includes("/api/")) dirty = true; });
      for (const [i, label] of controls) {
        if (seen.has(label)) continue; seen.add(label);
        if (dirty) await restart();
        dirty = false;
        await p.goto("about:blank"); await setup(p);
        await p.evaluate(eval(CONTROLS));
        const loc = p.locator(`[data-hunt-i="${i}"]`);
        if (!(await loc.count())) { r.clicks.push([label, "GONE after reload"]); continue; }
        const before = await p.evaluate(eval(SNAP));
        errs.length = 0;
        let res;
        try { await loc.click({ timeout: 1500 }); await p.waitForTimeout(350); res = (await p.evaluate(eval(SNAP))) !== before ? "ok" : "NO CHANGE"; }
        catch (e) { const msg = String(e).split("\n"); const cov = msg.find((l) => l.includes("intercepts pointer events")); res = "BLOCKED: " + (cov || msg[0]).trim().slice(0, 160); }
        if (errs.length) res += " | " + errs.join("; ").slice(0, 200);
        r.clicks.push([label, res]);
      }
    }
    results[key] = r;
    const bad = r.clicks.filter((c) => c[1] !== "ok");
    console.log(`${key}: ${setupErr ? "SETUP " + setupErr + " " : ""}errors ${r.errors.length}, axe ${r.axe.reduce((a, v) => a + v.count, 0)} in ${r.axe.length} rules, controls ${r.clicks.length} (${bad.length} flagged), trunc ${r.layout.trunc.length}, spill ${r.layout.spill.length}, offboard ${r.layout.offboard.length}, small ${r.layout.small.length}, clip384 ${r.layout.clip384.length}${r.errors.length ? "\n  " + r.errors.join("\n  ") : ""}`);
    await ctx.close();
  }
  await b.close();
  server.kill();
  fs.writeFileSync(`${OUT}/results${only.length ? "-" + only.join("-").replace(/\W+/g, "_") : ""}.json`, JSON.stringify(results, null, 1));
})();
