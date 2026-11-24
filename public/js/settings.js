/**
 * Settings, a page of its own (#/settings), from the Settings boards.
 *
 *   #/settings                 the section list on a phone, Connections on a wide screen
 *   #/settings/<section>       connections · look · agent · typing
 *   #/settings/profile/<id>    the profile editor (inside Connections)
 *
 * Every section keeps the same order of weight: what's in use first (raised
 * tiles), then the things you edit (raised rows), then plumbing you set
 * once (flat rows). Each entry in the section list carries a live one-line
 * summary, and a failing connection turns its summary pink.
 *
 * Changes save as you make them. Look changes the whole app live, but this
 * page never gets dimmer or more see-through than the readable defaults
 * (app.css, "settings: the readable floor"), while the Look preview shows
 * the real result.
 */

import { $, api, attempt, dayLabel, escapeHtml, fmt, go, isPhone, shortModel, showError, state } from "./core.js";
import { icon } from "./icons.js";
import { closeOverlay, confirmDialog, openOverlay } from "./overlay.js";
import { applyBackground, belowReadable, FINISHES, preparePhoto, READABLE_DIM, readable, windowDefault } from "./theme.js";
import { openAgentTab } from "./agent.js";

const SECTIONS = {
  connections: { name: "Connections", icon: icon.plug },
  look: { name: "Look", icon: icon.picture },
  agent: { name: "Agent", icon: icon.spark },
  typing: { name: "Typing", icon: icon.keyboard },
};
const PROVIDER_NAME = { nanogpt: "nanoGPT", vertex: "Vertex AI" };
const READABLE_LABEL = "Back to readable: reset dim and window to their defaults";
const EFFORTS = ["off", "low", "medium", "high"];

/** What this page shows that isn't saved anywhere. */
const ui = {
  /** connections · look · agent · typing · profile · sections (phone only) */
  section: "connections",
  profileId: null,
  /** The provider whose setup panel is open, if any. */
  setup: null,
  /** What's typed in a setup panel so far. */
  draft: {},
  /** "More controls" open in the profile editor. */
  more: false,
  /** Profiles made on this visit: they get the "starts with the defaults" note. */
  fresh: new Set(),
  /** The last test of each profile: { ok, ms, message } or "running". */
  tests: {},
  /** Provider tests under way. */
  testing: {},
  /** A profile's model on the other provider, so switching back and forth doesn't lose it. */
  lastModel: {},
  /** Extra JSON being typed that isn't valid yet (not saved). */
  json: {},
  /** The agent's notes and edits, for its section. */
  agent: null,
};

/** Model lists, by provider, once loaded. */
const models = {};

// ------------------------------------------------------------------ helpers

const profileOf = (id) => state.profiles.find((p) => p.id === id) ?? null;
const providers = () => state.providers ?? { nanogpt: { set: state.apiKeySet, health: null }, vertex: { set: state.vertexReady, health: null } };
const health = (provider) => providers()[provider]?.health ?? null;
const failing = (provider) => Boolean(health(provider) && !health(provider).ok);
const bg = () => state.settings.background;
const win = () => bg().window ?? windowDefault();
const num = (v, d) => Number(v).toFixed(d);
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** A failure in a few words: "key rejected", "out of credit"… */
function reason(h) {
  if (!h || h.ok) return "";
  if (h.status === 401 || h.status === 403) return "key rejected";
  if (h.status === 402) return "out of credit";
  if (h.status === 429) return "rate-limited";
  if (h.status === 404) return "model not found";
  if (h.status) return `error ${h.status}`;
  return /longer than/.test(h.message) ? "timed out" : "can't reach it";
}

function ago(iso) {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)} h ago`;
  return dayLabel(iso);
}

/** "Rooftop and Slow burn": the profiles on a provider. */
function usedBy(provider) {
  const names = state.profiles.filter((p) => p.provider === provider).map((p) => p.name);
  if (!names.length) return "no profile uses it yet";
  return `used by ${names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`}`;
}

/** A model's second line in the list: "128k context · reasons first". */
function modelSub(m) {
  if (!m) return "";
  const ctx = m.contextLength ? (m.contextLength >= 1e6 ? `${Math.round(m.contextLength / 1e5) / 10}M context` : `${m.contextLength % 1024 === 0 ? m.contextLength / 1024 : Math.round(m.contextLength / 1000)}k context`) : "";
  return [ctx, m.reasoning ? "reasons first" : ""].filter(Boolean).join(" · ");
}

const findModel = (p) => (models[p.provider] && Array.isArray(models[p.provider]) ? models[p.provider].find((m) => m.id === p.model) : null);

/** The params line on a tile and a profile row. */
const paramsOf = (p) => `temperature ${p.temperature} · up to ${fmt(p.maxTokens)} tokens`;

/** One section's summary for the section list, and whether it's a failure. */
function summary(key) {
  const s = state.settings;
  if (key === "connections") {
    if (!state.profiles.length) return { text: "no profiles yet", bad: false };
    const story = profileOf(s.rpProfileId);
    const agent = profileOf(s.agentProfileId);
    if (story && failing(story.provider)) return { text: `story replies are failing: ${reason(health(story.provider))}`, bad: true };
    if (agent && failing(agent.provider)) return { text: `the agent is failing: ${reason(health(agent.provider))}`, bad: true };
    const m = (p) => (p ? shortModel(p.model) || "no model yet" : "not picked");
    return { text: `story: ${m(story)} · agent: ${m(agent)}`, bad: false };
  }
  if (key === "look") {
    const photo = state.photos.find((p) => p.id === bg().photo);
    return { text: `lacquer · ${bg().finish} · ${photo ? photo.name : "no photo"}${belowReadable(bg()) ? " · below readable" : ""}`, bad: false };
  }
  if (key === "agent") return { text: "edits directly, all logged", bad: false };
  return { text: s.enterSends === false ? "Enter adds a line" : "Enter sends", bad: false };
}

// ------------------------------------------------------------------ the page

/** Called by the router: `section` and `sub` from #/settings/<section>/<sub>. */
export async function showSettings(section = "", sub = "") {
  if (section === "profile") {
    if (!profileOf(sub)) return go("#/settings/connections");
    if (ui.profileId !== sub) ui.more = false;
    ui.profileId = sub;
    ui.section = "profile";
  } else ui.section = SECTIONS[section] ? section : isPhone() ? "sections" : "connections";
  if (ui.section !== "connections") ui.setup = null;
  render();
  if (ui.section === "profile") loadModels(profileOf(ui.profileId).provider);
  if (ui.section === "agent") loadAgentInfo();
}

function render() {
  const view = $("view-settings");
  const sectionsMode = ui.section === "sections";
  view.dataset.mode = sectionsMode ? "sections" : "page";
  renderHead();
  renderNav();
  const main = $("settings-main");
  const sec = ui.section === "profile" ? "connections" : ui.section;
  main.setAttribute("aria-label", sectionsMode ? "Settings" : `${SECTIONS[sec].name} settings`);
  if (!sectionsMode) {
    $("settings-body").innerHTML = { connections: connectionsHtml, profile: editorHtml, look: lookHtml, agent: agentHtml, typing: typingHtml }[ui.section]();
    afterRender();
  }
}

/** Redraw the section's content, keeping the scroll place and focus. */
function redraw() {
  const main = $("settings-main");
  const top = main.scrollTop;
  const active = document.activeElement;
  const key = active && main.contains(active) ? focusKey(active) : null;
  render();
  main.scrollTop = top;
  if (key) main.querySelector(key)?.focus({ preventScroll: true });
}

/** A selector that finds the same control again after a redraw. */
function focusKey(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  for (const attr of ["data-assign", "data-photo", "data-finish", "data-provider", "data-effort", "data-enter", "data-setup", "data-test", "data-fix", "data-readable", "data-more"]) {
    if (el.hasAttribute(attr)) return `[${attr}="${CSS.escape(el.getAttribute(attr))}"]`;
  }
  return null;
}

function renderHead() {
  const back = $("settings-back");
  back.innerHTML = icon.left(18);
  const chat = state.chats.find((c) => c.id === state.chatId);
  let title = "Settings";
  if (ui.section === "sections") {
    back.href = chat ? `#/chat/${chat.id}` : "#/";
    back.setAttribute("aria-label", chat ? `Back to ${chat.name}` : "Back to the chat");
  } else if (ui.section === "profile") {
    back.href = "#/settings/connections";
    back.setAttribute("aria-label", "Back to Connections");
    title = ui.fresh.has(ui.profileId) ? "New profile" : "Profile";
  } else {
    back.href = "#/settings";
    back.setAttribute("aria-label", "Back to Settings");
    title = SECTIONS[ui.section].name;
  }
  // On a wide screen the page is always "Settings"; on a phone the header names the page you're on.
  $("settings-title").textContent = isPhone() ? title : "Settings";
}

function renderNav() {
  const current = ui.section === "profile" ? "connections" : ui.section;
  const phone = isPhone();
  const items = Object.entries(SECTIONS)
    .map(([key, s]) => {
      const sum = summary(key);
      const here = !phone && key === current;
      return `<li><a class="${phone ? "raised snavp" : "snav"} press" href="#/settings/${key}" ${here ? 'aria-current="true"' : ""}>
        <span class="ic">${s.icon()}</span><span class="txt"><span class="n">${s.name}</span><span class="s ${sum.bad ? "bad" : ""}">${escapeHtml(sum.text)}</span></span>${phone ? `<span class="go">${icon.right(18)}</span>` : ""}</a></li>`;
    })
    .join("");
  $("settings-nav").innerHTML = `${phone ? '<p class="meta saves">changes save as you make them</p>' : ""}<ul class="snav-list">${items}</ul>`;
}

/** Things a redraw needs set that HTML can't carry. */
function afterRender() {
  for (const s of $("settings-body").querySelectorAll(".slider")) fill(s);
  const dlg = $("model-picker");
  if (dlg.open) renderPicker();
}

/** The section's heading: shown on a wide screen; on a phone the page header names it, so it's for screen readers only. */
const sechead = (name) => `<h2 class="sechead ${isPhone() ? "sr" : ""}">${name}</h2>`;

// -------------------------------------------------------------- connections

function connectionsHtml() {
  const rows = state.profiles.map(profileRow).join("");
  return `${sechead("Connections")}
    <p class="secsub">Which model writes what, the profiles behind them, and the keys those use.</p>
    <div class="hero">${tileHtml("story")}${tileHtml("agent")}</div>
    <div class="grouphead"><h3 class="eyebrow" id="profiles-h">profiles</h3><button type="button" class="btn ghost press new-prof" data-new-profile>${icon.plus(16)}new profile</button></div>
    ${rows ? `<ul class="prof-list" aria-labelledby="profiles-h">${rows}</ul><p class="meta note">Tags show where each profile is in use.</p>` : `<p class="meta note">No profiles yet. A profile is a model and how it writes; make one, then pick it for story replies or the agent.</p>`}
    <div class="grouphead"><h3 class="eyebrow">providers</h3><span class="meta">set once; every profile uses these</span></div>
    <div class="setgroup">${providerRow("nanogpt")}${ui.setup === "nanogpt" ? nanoSetup() : ""}${providerRow("vertex")}${ui.setup === "vertex" ? vertexSetup() : ""}</div>`;
}

/** The status beside a job or a profile: [dot class, words]. */
function statusOf(p) {
  if (!p) return ["dot-off", "pick a profile"];
  if (!p.model) return ["dot-off", "no model yet"];
  if (!providers()[p.provider]?.set) return ["dot-off", p.provider === "vertex" ? "Vertex AI isn't set up" : "no nanoGPT key yet"];
  const h = health(p.provider);
  if (!h) return ["dot-off", "not tried yet"];
  if (!h.ok) return ["dot-bad", `failing · ${reason(h)}`];
  return ["dot-ok", `connected · ${secs(h.ms)}`];
}

function tileHtml(job) {
  const id = job === "story" ? state.settings.rpProfileId : state.settings.agentProfileId;
  const p = profileOf(id);
  const [dot, words] = statusOf(p);
  const h = p ? health(p.provider) : null;
  const label = job === "story" ? "story replies" : "the agent";
  let fail = "";
  if (p && h && !h.ok) {
    const name = PROVIDER_NAME[p.provider];
    const why = reason(h) === "key rejected" ? `${name} rejected the key.` : `${name}: ${h.message}`;
    const fix = reason(h) === "key rejected" ? `<button type="button" class="btn raised press" data-fix="${p.provider}">fix the key</button>` : "";
    fail = `<div class="failnote" role="alert"><span class="grow">The last ${h.failures === 1 ? "try" : `${h.failures} tries`} failed: ${escapeHtml(why)}</span>${fix}</div>`;
  }
  return `<div class="raised htile">
    <div class="top"><span class="eyebrow" id="asg-${job}-l">${label}</span><span class="stat"><span class="dot ${dot}"></span>${escapeHtml(words)}</span></div>
    <button type="button" class="select sunk press" id="asg-${job}-b" data-assign="${job}" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="asg-${job}-l asg-${job}-b">
      <span class="sel-txt"><span class="big">${p ? escapeHtml(p.name) : state.profiles.length ? "choose a profile" : "make a profile first"}</span><span class="sub">${p ? `${escapeHtml(p.model || "no model yet")} · ${PROVIDER_NAME[p.provider]}` : "nothing does this yet"}</span></span><span class="caret">${icon.down()}</span>
    </button>
    ${p ? `<span class="params">${paramsOf(p)} · reasoning ${p.reasoningEffort && p.reasoningEffort !== "none" ? p.reasoningEffort : "off"}</span>` : ""}
    ${fail}
  </div>`;
}

function tagsOf(p, long = false) {
  const t = [];
  if (p.id === state.settings.rpProfileId) t.push(`<span class="stag stag-story">${long ? "writes story replies" : "story replies"}</span>`);
  if (p.id === state.settings.agentProfileId) t.push(`<span class="stag stag-agent">${long ? "runs the agent" : "agent"}</span>`);
  return t.join("");
}

function profileRow(p) {
  return `<li><a class="raised prof press" href="#/settings/profile/${p.id}">
    <span class="pmain"><span class="n">${escapeHtml(p.name)}</span><span class="m">${escapeHtml(p.model || "no model yet")} · ${PROVIDER_NAME[p.provider]} · ${paramsOf(p)}</span></span>
    ${tagsOf(p)}<span class="go">${icon.right(18)}</span></a></li>`;
}

function providerRow(id) {
  const v = providers()[id] ?? {};
  const h = v.health;
  let dot = "dot-off";
  let words = id === "nanogpt" ? "no key yet" : "not set up";
  if (v.set) [dot, words] = !h ? ["dot-off", "not tested yet"] : h.ok ? ["dot-ok", "connected"] : ["dot-bad", reason(h)];
  let hint;
  if (h && !h.ok) hint = `${h.message.replace(/\.$/, "")}, ${ago(h.at)} · ${usedBy(id)}`;
  else if (id === "nanogpt") hint = v.set ? `API key ending ${escapeHtml(v.last4)}${v.source === "env" ? " (from .env)" : ""} · ${usedBy(id)}${h?.ok ? ` · answered in ${secs(h.ms)}` : ""}` : "Paste a key from your nanoGPT account page.";
  else hint = v.set ? `project ${escapeHtml(v.project)} · ${escapeHtml(v.location)}${v.source === "env" ? " (from .env)" : ""} · ${usedBy(id)}${h?.ok ? ` · answered in ${secs(h.ms)}` : ""}` : "A Google Cloud project with Vertex AI, and a service account key for it.";
  const open = ui.setup === id;
  const loud = !v.set || (h && !h.ok);
  const change = id === "nanogpt" ? (v.set ? "change key" : "add a key") : v.set ? "change" : "set up";
  const testing = ui.testing[id];
  return `<div class="setrow provrow">
    <span class="lbl">${PROVIDER_NAME[id]} <span class="stat"><span class="dot ${dot}"></span>${escapeHtml(words)}</span></span>
    <span class="hint ${h && !h.ok ? "bad" : ""}">${escapeHtml(hint).replaceAll("&amp;", "&")}</span>
    <span class="ctl"><button type="button" class="btn press ${loud ? "raised" : "ghost quiet"}" data-setup="${id}" aria-expanded="${open}">${change}</button><button type="button" class="btn raised press" data-test="${id}" aria-disabled="${!v.set || Boolean(testing)}">${testing ? "testing…" : "test"}</button></span>
  </div>`;
}

function nanoSetup() {
  const key = ui.draft.nanoKey ?? "";
  return `<div class="raised setup" role="group" aria-label="nanoGPT key">
    <div class="setrow wide">
      <label class="lbl" for="nkey">New API key</label>
      <span class="hint">from your nanoGPT account page. After saving, only its last four characters show.</span>
      <div class="ctl"><input id="nkey" class="sunk inp" type="password" autocomplete="off" spellcheck="false" placeholder="paste the key here" value="${escapeHtml(key)}" /></div>
    </div>
    <div class="setup-foot"><button type="button" class="btn ghost press quiet" data-setup-cancel>cancel</button><button type="button" class="btn btn-primary press" data-setup-save="nanogpt" aria-disabled="${!key.trim()}">save and test</button></div>
  </div>`;
}

function vertexSetup() {
  const v = providers().vertex ?? {};
  const d = ui.draft;
  const region = (state.regions ?? []).find(([r]) => r === d.location) ?? [d.location, ""];
  const file = d.keyName ?? v.keyName;
  return `<div class="raised setup" role="group" aria-label="Vertex AI setup">
    <div class="setrow">
      <label class="lbl" for="vproj">Project ID</label>
      <span class="hint">the Google Cloud project that has Vertex AI turned on</span>
      <span class="ctl"><input id="vproj" class="sunk inp vfield" autocomplete="off" spellcheck="false" value="${escapeHtml(d.project ?? "")}" placeholder="my-project-123" /></span>
    </div>
    <div class="setrow">
      <span class="lbl" id="vreg-l">Region</span>
      <span class="hint">where requests run. Pick the one nearest you that has your model.</span>
      <span class="ctl"><button type="button" class="select sunk press vfield" id="vreg-b" data-region aria-haspopup="listbox" aria-expanded="false" aria-labelledby="vreg-l vreg-b"><span class="sel-txt">${escapeHtml(region[0])}<span class="sub">${escapeHtml(region[1])}</span></span><span class="caret">${icon.down()}</span></button></span>
    </div>
    <div class="setrow">
      <span class="lbl" id="vkey-l">Service account key</span>
      <span class="hint">the JSON key file for a service account allowed to use Vertex AI</span>
      <span class="ctl">${file ? `<span class="filechip sunk"><span class="dot ${d.keyJson ? "dot-off" : "dot-ok"}"></span>${escapeHtml(file)}</span>` : ""}<label class="btn ghost press file-btn">${file ? "choose another" : "choose the file"}<input type="file" accept="application/json,.json" id="vkey-file" class="sr-file" aria-labelledby="vkey-l" /></label></span>
    </div>
    <div class="setup-foot"><span class="stat"><span class="dot dot-off"></span>${d.keyJson ? "new key file, not saved yet" : "not tested yet"}</span><button type="button" class="btn ghost press quiet" data-setup-cancel>cancel</button><button type="button" class="btn btn-primary press" data-setup-save="vertex" aria-disabled="${!(d.project ?? "").trim() || !file}">save and test</button></div>
  </div>`;
}

function openSetup(id) {
  if (ui.setup === id) {
    ui.setup = null;
    return redraw();
  }
  const v = providers().vertex ?? {};
  ui.setup = id;
  ui.draft = id === "nanogpt" ? { nanoKey: "" } : { project: v.project ?? "", location: v.location || "global" };
  redraw();
  // The panel opens at the bottom, often from "fix the key" at the top: bring it into view.
  const panel = $("settings-body").querySelector(".setup");
  panel?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  panel?.querySelector("input:not([type=file])")?.focus({ preventScroll: true });
}

async function saveSetup(id) {
  const body = id === "nanogpt" ? { key: ui.draft.nanoKey } : { project: ui.draft.project?.trim(), location: ui.draft.location, ...(ui.draft.keyJson ? { keyJson: ui.draft.keyJson, keyName: ui.draft.keyName } : {}) };
  const saved = await attempt(() => api("PUT", `/api/providers/${id}`, body));
  if (!saved) return;
  state.providers = saved;
  state.apiKeySet = saved.nanogpt.set;
  state.vertexReady = saved.vertex.set;
  ui.setup = null;
  ui.draft = {};
  redraw();
  $("settings-body").querySelector(`[data-setup="${id}"]`)?.focus();
  // Test straight away when there's a profile to test with.
  if (state.profiles.some((p) => p.provider === id && p.model)) testProvider(id);
}

async function testProvider(id) {
  if (ui.testing[id]) return;
  ui.testing[id] = true;
  redraw();
  try {
    const result = await api("POST", `/api/providers/${id}/test`, {});
    state.providers = result.providers;
  } catch (error) {
    showError(error.message);
  } finally {
    ui.testing[id] = false;
    redraw();
  }
}

// ----------------------------------------------------------- profile editor

function editorHtml() {
  const p = profileOf(ui.profileId);
  const json = ui.json[p.id] ?? p.extraParams;
  const jsonState = jsonCheck(json);
  const effort = p.reasoningEffort && p.reasoningEffort !== "none" ? p.reasoningEffort : "off";
  const topP = p.topP ?? 1;
  const minP = p.minP ?? 0;
  const inUse = p.id === state.settings.rpProfileId || p.id === state.settings.agentProfileId;
  const m = findModel(p);
  const t = ui.tests[p.id];
  let test = p.model ? ["dot-off", "not tested yet"] : ["dot-off", "choose a model to test it"];
  if (t === "running") test = ["dot-off", "testing…"];
  else if (t && p.model) test = t.ok ? ["dot-ok", `answered in ${secs(t.ms)}`] : ["dot-bad", t.message];
  return `<a class="btn ghost press quiet back-conn wide-only" href="#/settings/connections">${icon.left(18)}Connections</a>
    <h2 class="sr">Profile</h2>
    <label class="sr" for="pname">Profile name</label>
    <input id="pname" class="inp pname" value="${escapeHtml(p.name)}" placeholder="name this profile" autocomplete="off" />
    <div class="ptags">${tagsOf(p, true)}${inUse ? "" : '<span class="meta">not in use yet</span>'}</div>
    ${ui.fresh.has(p.id) && !inUse ? '<p class="meta note">Starts with the usual defaults. Nothing uses it until you pick it for story replies or the agent.</p>' : ""}
    <div class="grouphead"><h3 class="eyebrow">model</h3></div>
    <div class="setgroup">
      <div class="setrow">
        <span class="lbl" id="prov-l">Provider</span>
        <span class="hint">where requests go. Keys live under Providers.</span>
        <span class="ctl"><span class="seg sunk" role="tablist" aria-labelledby="prov-l">${["nanogpt", "vertex"].map((id) => `<button type="button" role="tab" data-provider="${id}" aria-selected="${p.provider === id}">${PROVIDER_NAME[id]}</button>`).join("")}</span></span>
      </div>
      <div class="setrow wide">
        <span class="lbl" id="model-l">Model</span>
        <span class="hint">the list comes from the provider, so it's always current. Type to search it.</span>
        <div class="ctl"><button type="button" class="select sunk press" id="model-b" aria-haspopup="dialog" aria-expanded="${$("model-picker").open}" aria-labelledby="model-l model-b"><span class="sel-txt"><span>${escapeHtml(p.model || "choose a model")}</span><span class="sub" id="model-sub">${escapeHtml(modelSub(m) || `from ${PROVIDER_NAME[p.provider]}'s list`)}</span></span><span class="caret">${icon.down()}</span></button></div>
      </div>
    </div>
    <div class="grouphead"><h3 class="eyebrow">how it writes</h3></div>
    <div class="setgroup">
      ${sliderRow({ id: "sl-temp", field: "temperature", label: "Temperature", hint: "how far it strays from the likeliest next word", value: p.temperature, min: 0, max: 2, step: 0.05, ends: ["steady", "loose"] })}
      <div class="setrow">
        <label class="lbl" for="maxt">Longest reply</label>
        <span class="hint"><span id="maxt-words">${words(p.maxTokens)}</span>. A reply stops here, even mid-sentence.</span>
        <span class="ctl"><label class="numfield sunk"><input id="maxt" inputmode="numeric" autocomplete="off" value="${fmt(p.maxTokens)}" aria-describedby="maxt-u" /><span class="unit" id="maxt-u">tokens</span></label></span>
      </div>
    </div>
    <div class="more-wrap">
      <button type="button" class="more press" data-more aria-expanded="${ui.more}" aria-controls="more-ctl"><span class="grow"><span class="n">More controls</span><span class="s" id="more-sum">${moreSummary(p)}</span></span><span class="chev">${icon.down()}</span></button>
      <div id="more-ctl" class="setgroup" ${ui.more ? "" : "hidden"}>
        ${sliderRow({ id: "sl-topP", field: "topP", label: "Top P", hint: "keeps only the likeliest words that add up to this share. 1 keeps them all.", value: topP, min: 0, max: 1, step: 0.01 })}
        ${sliderRow({ id: "sl-minP", field: "minP", label: "Min P", hint: "drops words less likely than this share of the top word. 0 drops none.", value: minP, min: 0, max: 0.5, step: 0.01 })}
        <div class="setrow">
          <span class="lbl" id="eff-l">Reasoning</span>
          <span class="hint">thinks before it writes. Slower, and only some models can.</span>
          <span class="ctl"><span class="seg sunk" role="tablist" aria-labelledby="eff-l">${EFFORTS.map((e) => `<button type="button" role="tab" data-effort="${e}" aria-selected="${effort === e}">${e}</button>`).join("")}</span></span>
        </div>
        <div class="setrow wide">
          <label class="lbl" for="xjson">Extra parameters</label>
          <span class="hint">JSON, sent as-is with every request. For anything the controls above don't cover.</span>
          <div class="ctl col"><textarea id="xjson" class="sunk json" spellcheck="false" placeholder='{"repetition_penalty": 1.05}'>${escapeHtml(json)}</textarea>
            <span class="stat" id="json-stat" role="status"><span class="dot ${jsonState.dot}"></span>${jsonState.text}</span></div>
        </div>
      </div>
    </div>
    <div class="pfoot">
      <button type="button" class="btn raised press" data-test-profile aria-disabled="${!p.model || t === "running"}">test this profile</button>
      <span class="stat grow" role="status"><span class="dot ${test[0]}"></span><span class="test-txt">${escapeHtml(test[1])}</span></span>
      <button type="button" class="btn btn-quiet-danger press" data-delete-profile>${icon.trash()}delete profile</button>
    </div>`;
}

function sliderRow({ id, field, label, hint, value, min, max, step, ends }) {
  const d = 2;
  return `<div class="setrow wide">
    <div class="valrow"><label class="lbl" for="${id}">${label}</label><span class="val" aria-hidden="true">${num(value, d)}</span></div>
    <span class="hint">${hint}</span>
    <div class="ctl col"><input id="${id}" class="slider" type="range" data-field="${field}" min="${min}" max="${max}" step="${step}" value="${value}" aria-valuetext="${num(value, d)}" />
      ${ends ? `<div class="slidends" aria-hidden="true"><span>${ends[0]}</span><span>${ends[1]}</span></div>` : ""}</div>
  </div>`;
}

const words = (tokens) => `about ${fmt(Math.round((tokens * 0.75) / 50) * 50)} words`;

/** "top P 1 · min P 0.05 · reasoning off · no extra parameters", with what's changed from the defaults in bold. */
function moreSummary(p) {
  const json = ui.json[p.id] ?? p.extraParams;
  const check = jsonCheck(json);
  const n = check.ok && json.trim() ? Object.keys(JSON.parse(json)).length : 0;
  const effort = p.reasoningEffort && p.reasoningEffort !== "none" ? p.reasoningEffort : "off";
  const parts = [
    [`top P ${num(p.topP ?? 1, 2).replace(/\.?0+$/, "")}`, p.topP != null && p.topP !== 1],
    [`min P ${num(p.minP ?? 0, 2).replace(/\.?0+$/, "")}`, p.minP != null && p.minP !== 0],
    [`reasoning ${effort}`, effort !== "off"],
    [json.trim() ? `${n} extra parameter${n === 1 ? "" : "s"}` : "no extra parameters", Boolean(json.trim())],
  ];
  return parts.map(([t, changed], i) => `<span class="${changed ? "chg" : ""}">${escapeHtml(t)}</span>${i < parts.length - 1 ? " · " : ""}`).join("");
}

function jsonCheck(text) {
  if (!text.trim()) return { ok: true, dot: "dot-off", text: "nothing extra" };
  try {
    const v = JSON.parse(text);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return { ok: false, dot: "dot-bad", text: "needs to be one JSON object, in { }, so it won't be sent" };
    return { ok: true, dot: "dot-ok", text: "valid JSON" };
  } catch {
    return { ok: false, dot: "dot-bad", text: "isn't valid JSON yet, so it won't be sent" };
  }
}

/** Save fields of the open profile, a moment after the last change. */
const pending = {};
let profileTimer = 0;
function saveProfile(change, now = false) {
  const p = profileOf(ui.profileId);
  if (!p) return;
  Object.assign(p, change);
  Object.assign(pending, change);
  clearTimeout(profileTimer);
  const id = p.id;
  const flush = async () => {
    const body = { ...pending };
    for (const k of Object.keys(pending)) delete pending[k];
    try {
      const saved = await api("PATCH", `/api/profiles/${id}`, body);
      const local = profileOf(id);
      if (local) Object.assign(local, saved, pending);
      renderNav();
    } catch (error) {
      showError(error.message);
    }
  };
  if (now) flush();
  else profileTimer = setTimeout(flush, 300);
}

async function loadModels(provider) {
  if (models[provider] && !models[provider].unset) return;
  if (!providers()[provider]?.set) {
    // Nothing to ask yet: say where to set it up instead of failing a request.
    models[provider] = { unset: true, error: `${PROVIDER_NAME[provider]} isn't set up yet. Set it up under Providers in Connections.` };
  } else models[provider] = "loading";
  if (models[provider] !== "loading") {
    if ($("model-picker").open) renderPicker();
    return;
  }
  try {
    models[provider] = await api("GET", `/api/models?provider=${provider}`);
  } catch (error) {
    models[provider] = { error: error.message };
  }
  const p = profileOf(ui.profileId);
  if (ui.section === "profile" && p?.provider === provider) {
    const sub = $("model-sub");
    if (sub) sub.textContent = modelSub(findModel(p)) || `from ${PROVIDER_NAME[provider]}'s list`;
  }
  if ($("model-picker").open) renderPicker();
}

// ------------------------------------------------------------ model picker

const picker = { q: "", active: 0, list: [] };

function openPicker(opener) {
  const p = profileOf(ui.profileId);
  picker.q = "";
  picker.active = -1;
  const dlg = $("model-picker");
  dlg.innerHTML = `<div class="find"><span class="find-ic">${icon.search(17)}</span><input class="sunk inp" id="model-q" role="combobox" aria-expanded="true" aria-controls="mlist" aria-autocomplete="list" aria-label="Search models" autocomplete="off" spellcheck="false" /></div>
    <ul id="mlist" role="listbox" aria-label="Models" tabindex="-1"></ul>
    <p class="meta none" id="mnone" hidden></p>
    <span class="meta count" id="mcount"></span>`;
  dlg.style.setProperty("--w", `${opener.getBoundingClientRect().width}px`);
  opener.setAttribute("aria-expanded", "true");
  renderPicker();
  openOverlay(dlg, {
    opener,
    anchor: opener,
    focus: "#model-q",
    onClose: () => opener.isConnected && opener.setAttribute("aria-expanded", "false"),
  });
  loadModels(p.provider);
}

function renderPicker() {
  const p = profileOf(ui.profileId);
  if (!p) return;
  const all = models[p.provider];
  const name = PROVIDER_NAME[p.provider];
  const q = picker.q.trim().toLowerCase();
  const input = $("model-q");
  const list = $("mlist");
  const none = $("mnone");
  const count = $("mcount");
  if (!input) return;
  if (!Array.isArray(all)) {
    input.placeholder = `search ${name}'s models`;
    list.innerHTML = "";
    none.hidden = false;
    none.textContent = all?.unset ? all.error : all?.error ? `Couldn't load the list: ${all.error}` : "Loading the list…";
    count.textContent = "";
    return;
  }
  input.placeholder = `search ${name}'s ${fmt(all.length)} models`;
  picker.list = all.filter((m) => !q || m.id.toLowerCase().includes(q));
  const shown = picker.list.slice(0, 300);
  if (picker.active >= shown.length) picker.active = shown.length - 1;
  list.innerHTML = shown
    .map(
      (m, i) => `<li role="option" id="mopt-${i}" data-model="${escapeHtml(m.id)}" aria-selected="${m.id === p.model}" class="${i === picker.active ? "active" : ""}">
      <span class="grow"><span class="n">${escapeHtml(m.id)}</span>${modelSub(m) ? `<span class="sub">${escapeHtml(modelSub(m))}</span>` : ""}</span><span class="ok">${icon.tick()}</span></li>`,
    )
    .join("");
  if (picker.active >= 0) input.setAttribute("aria-activedescendant", `mopt-${picker.active}`);
  else input.removeAttribute("aria-activedescendant");
  none.hidden = shown.length > 0;
  none.textContent = "No model matches that. Check the spelling, or the model may be on the other provider.";
  count.textContent = `${q ? `${fmt(picker.list.length)} ${picker.list.length === 1 ? "match" : "matches"} of` : `showing ${fmt(shown.length)} of`} ${fmt(all.length)} · the list comes straight from ${name}`;
}

function pickModel(id) {
  const p = profileOf(ui.profileId);
  closeOverlay($("model-picker"));
  if (!p || id === p.model) return;
  saveProfile({ model: id }, true);
  redraw();
  $("model-b")?.focus();
}

// ------------------------------------------------------------- pick menus

/** A short list (which profile does a job, the Vertex region) in a menu under its button. */
function openPick(opener, { label, options, selected, onPick }) {
  const dlg = $("pick-menu");
  dlg.setAttribute("aria-label", label);
  dlg.innerHTML = `<div role="listbox" aria-label="${escapeHtml(label)}">${options
    .map(([value, name, sub]) => `<button type="button" role="option" class="opt press" data-value="${escapeHtml(value)}" aria-selected="${value === selected}"><span>${escapeHtml(name)}</span>${sub ? `<span class="sub">${escapeHtml(sub)}</span>` : ""}</button>`)
    .join("")}</div>`;
  dlg.style.setProperty("--w", `${opener.getBoundingClientRect().width}px`);
  opener.setAttribute("aria-expanded", "true");
  dlg.onclick = (e) => {
    const b = e.target.closest("[data-value]");
    if (!b) return;
    closeOverlay(dlg);
    onPick(b.dataset.value);
  };
  openOverlay(dlg, { opener, anchor: opener, focus: '[aria-selected="true"], [role=option]', onClose: () => opener.isConnected && opener.setAttribute("aria-expanded", "false") });
}

async function assign(job, id) {
  const key = job === "story" ? "rpProfileId" : "agentProfileId";
  if (state.settings[key] === id) return;
  const settings = await attempt(() => api("PATCH", "/api/settings", { [key]: id }));
  if (!settings) return;
  state.settings = settings;
  redraw();
  $("settings-body").querySelector(`[data-assign="${job}"]`)?.focus();
}

// --------------------------------------------------------------------- look

function lookHtml() {
  const b = bg();
  const photo = state.photos.find((p) => p.id === b.photo);
  const wDef = windowDefault();
  const tick = (v, lo, hi) => ((v - lo) / (hi - lo)).toFixed(4);
  const choice = (checked) => `role="radio" aria-checked="${checked}"`;
  const chk = `<span class="chk">${icon.tick()}</span>`;
  const photos = state.photos
    .map(
      (p) => `<button type="button" class="choice photo press" ${choice(b.photo === p.id)} data-photo="${p.id}" aria-label="${escapeHtml(p.name)}">
        <img class="img" src="${escapeHtml(p.url)}" alt="" loading="lazy" style="object-position:${escapeHtml(p.position)}" />${chk}<span class="cap">${escapeHtml(p.name)}</span></button>`,
    )
    .join("");
  const finishes = Object.entries(FINISHES)
    .map(
      ([k, f]) => `<button type="button" class="choice raised fin press" ${choice(b.finish === k)} data-finish="${k}">
        <span class="sw" aria-hidden="true">${photo ? `<img src="${escapeHtml(photo.url)}" alt="" style="object-position:${escapeHtml(photo.position)}" />` : ""}<span class="ov fin-${k}"></span></span>${chk}<span class="n">${k}</span><span class="d">${FIN_DESC[k]}</span></button>`,
    )
    .join("");
  return `${sechead("Look")}
    <p class="secsub">Everything behind and around the story. The preview shows exactly how a chat will look. This page follows along, but never gets harder to read than the defaults, so you can always find your way back.</p>
    <div class="lk-preview" role="img" aria-label="Preview of a chat with these settings">
      ${photo ? `<img class="pv-img" src="${escapeHtml(photo.url)}" alt="" style="object-position:${escapeHtml(photo.position)}" />` : ""}
      <div class="pv-dim"></div>
      <div class="pv-col glass" aria-hidden="true"><span class="eyebrow">chats</span>${state.chats
        .slice(0, 3)
        .map((c, i) => `<span class="${i ? "pv-other" : "pv-cur"}">${escapeHtml(c.name)}</span>`)
        .join("")}</div>
      <div class="pv-story ${photo ? "on-photo" : ""}"><span class="eyebrow">narrator</span>By the time they reach the roof, the rain has turned the whole district into a mirror. Rumi stops at the railing and doesn't look back.</div>
    </div>
    <p class="readnote" role="status" id="readnote" data-below="${belowReadable(b)}">${readnoteHtml()}</p>
    <div class="grouphead"><h3 class="eyebrow" id="photo-h">photo</h3><span class="meta">behind everything</span></div>
    <div class="photo-grid2" role="radiogroup" aria-labelledby="photo-h">
      <button type="button" class="choice photo press" ${choice(b.photo === "none")} data-photo="none" aria-label="no photo"><span class="img sunk plain" aria-hidden="true">plain</span>${chk}<span class="cap">no photo</span></button>${photos}
      <label class="photo-add2 press"><span class="img add-img">${icon.plus(20)}</span><span class="cap">add a photo</span><input type="file" accept="image/jpeg,image/png,image/webp" id="photo-file" class="sr-file" /></label>
    </div>
    <p class="meta note" id="photo-status" role="status">${state.photos.length ? "" : "Add a photo of your own to sit behind the app. It's kept on your server, not shared."}</p>
    ${photo ? `<button type="button" class="btn btn-quiet-danger press rm-photo" data-remove-photo="${photo.id}">${icon.trash()}remove “${escapeHtml(photo.name)}”</button>` : ""}
    <div class="grouphead"><h3 class="eyebrow" id="fin-h">lacquer</h3></div>
    <div class="fin-grid" role="radiogroup" aria-labelledby="fin-h">${finishes}</div>
    <div class="setgroup">
      ${lookSlider({ id: "lk-tint", key: "tint", label: "Tint", hint: "how much of the photo's colour the lacquer takes on", value: b.tint, min: 0, max: 1, step: 0.05, ends: ["plain black", "the photo's colour"] })}
    </div>
    <div class="grouphead"><h3 class="eyebrow">readability</h3>
      <button type="button" class="btn press ${belowReadable(b) ? "raised" : "ghost"}" data-readable aria-label="${READABLE_LABEL}">${icon.reset()}back to readable</button></div>
    <div class="setgroup">
      ${lookSlider({ id: "lk-dim", key: "dim", label: "Dim", hint: "darkens the photo everywhere. The mark is the readable default.", value: b.dim, min: 0, max: 0.8, step: 0.05, ends: ["photo as it is", "nearly black"], tick: tick(READABLE_DIM, 0, 0.8) })}
      ${lookSlider({ id: "lk-win", key: "window", label: "Reading column", hint: "how dark the column behind the story is. The mark is the readable default.", value: win(), min: 0.3, max: 0.95, step: 0.01, ends: ["see-through", "solid"], tick: tick(wDef, 0.3, 0.95) })}
    </div>`;
}

const FIN_DESC = { roiro: "opaque black lacquer", tamenuri: "lets the photo glow through", shunkei: "a clear coat, most photo" };

function lookSlider({ id, key, label, hint, value, min, max, step, ends, tick }) {
  return `<div class="setrow wide">
    <div class="valrow"><label class="lbl" for="${id}">${label}</label><span class="val" aria-hidden="true">${num(value, 2)}</span></div>
    <span class="hint">${hint}</span>
    <div class="ctl col"><div class="slidewrap"><input id="${id}" class="slider" type="range" data-bg="${key}" min="${min}" max="${max}" step="${step}" value="${value}" aria-valuetext="${num(value, 2)}" />${tick ? `<span class="deftick" aria-hidden="true" style="left:calc(11px + (100% - 22px) * ${tick})"></span>` : ""}</div>
      <div class="slidends" aria-hidden="true"><span>${ends[0]}</span><span>${ends[1]}</span></div></div>
  </div>`;
}

function readnoteHtml() {
  return belowReadable(bg())
    ? `<span class="dot dot-bad"></span><span class="warn-txt grow">Story text may be hard to read over a bright photo at these settings.</span><button type="button" class="btn raised press" data-readable="note" aria-label="${READABLE_LABEL}">${icon.reset()}back to readable</button>`
    : `<span class="dot dot-ok"></span><span class="ok-txt">At or past the readable defaults.</span>`;
}

/** The preview shows the real, unfloored dim and reading column. */
function paintPreview() {
  const pv = $("settings-body").querySelector(".lk-preview");
  if (!pv) return;
  pv.style.setProperty("--pv-dim", String(bg().dim));
  pv.style.setProperty("--pv-win", String(win()));
}

let bgTimer = 0;
/** Change the background: live everywhere at once, saved a moment after the last change. */
function saveBackground(change, redrawAfter = false) {
  Object.assign(state.settings.background, change);
  applyBackground(state.settings.background);
  clearTimeout(bgTimer);
  bgTimer = setTimeout(async () => {
    const saved = await attempt(() => api("PATCH", "/api/settings", { background: state.settings.background }));
    if (saved) state.settings.background = saved.background;
  }, 250);
  renderNav();
  if (redrawAfter) redraw();
  else {
    paintPreview();
    const note = $("readnote");
    const below = belowReadable(bg());
    if (note && note.dataset.below !== String(below)) {
      note.dataset.below = String(below);
      note.innerHTML = readnoteHtml();
    }
    const reset = $("settings-body").querySelector('.grouphead [data-readable]');
    if (reset) reset.className = `btn press ${below ? "raised" : "ghost"}`;
  }
}

async function addPhoto(file) {
  const status = $("photo-status");
  if (status) status.textContent = "Adding the photo…";
  try {
    const { blob, tint, name } = await preparePhoto(file);
    const q = new URLSearchParams({ name, tint, position: "50% 50%" });
    const response = await fetch(`api/photos?${q}`, { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && data.login) location.href = "login";
    if (!response.ok) throw new Error(data.error || "Couldn't add the photo.");
    state.photos = [...(state.photos ?? []), data];
    saveBackground({ photo: data.id }, true);
    $("settings-body").querySelector(`[data-photo="${data.id}"]`)?.focus();
  } catch (error) {
    if (status) status.textContent = "";
    showError(error.message);
  }
}

// -------------------------------------------------------------------- agent

function agentHtml() {
  const p = profileOf(state.settings.agentProfileId);
  const info = ui.agent;
  const notes = info ? (info.notes ? `${info.notes} note${info.notes === 1 ? "" : "s"} it keeps for itself. The index note is always loaded.` : "No notes yet. The index note is always loaded.") : "…";
  const edits = info ? (info.edits ? `${info.edits}${info.more ? "+" : ""} edit${info.edits === 1 ? "" : "s"}, newest ${dayLabel(info.newest)}. Each one can be reverted.` : "No edits yet. Each one can be reverted.") : "…";
  return `${sechead("Agent")}
    <p class="secsub">The helper in the side panel. It starts with no name and grows into one.</p>
    <div class="raised htile agent-tile">
      <button type="button" class="switch" role="switch" aria-checked="false" aria-disabled="true" aria-labelledby="ag-t" aria-describedby="ag-d"><span class="knob"></span></button>
      <span class="ag-txt"><span id="ag-t" class="ag-t">Ask before each edit</span>
        <span id="ag-d" class="ag-d">Off: the agent edits cards, blocks and nudges directly. Every edit lands in its edit log, where you can see it and revert it. Asking first arrives with the approval card, which isn't built yet.</span></span>
    </div>
    <div class="grouphead"><h3 class="eyebrow">its things</h3></div>
    <div class="setgroup">
      <div class="setrow"><span class="lbl">Runs on</span><span class="hint">${p ? `${escapeHtml(p.name)} · ${escapeHtml(p.model || "no model yet")} · ${PROVIDER_NAME[p.provider]}` : "no profile picked yet"}</span><span class="ctl"><a class="btn ghost press link" href="#/settings/connections">change in Connections</a></span></div>
      <div class="setrow"><span class="lbl">Its notes</span><span class="hint" id="ag-notes">${notes}</span><span class="ctl"><button type="button" class="btn ghost press link" data-agent-open="files">open notes</button></span></div>
      <div class="setrow"><span class="lbl">Edit log</span><span class="hint" id="ag-edits">${edits}</span><span class="ctl"><button type="button" class="btn ghost press link" data-agent-open="changes">open the log</button></span></div>
    </div>`;
}

async function loadAgentInfo() {
  try {
    const [data, edits] = await Promise.all([api("GET", "/api/agent"), api("GET", "/api/agent/edits?limit=1000")]);
    ui.agent = { notes: data.files.filter((f) => f.path.startsWith("notes/")).length, edits: edits.length, more: edits.length >= 1000, newest: edits[0]?.createdAt };
  } catch {
    ui.agent = null;
    return;
  }
  if (ui.section === "agent") redraw();
}

// ------------------------------------------------------------------- typing

function typingHtml() {
  const sends = state.settings.enterSends !== false;
  return `${sechead("Typing")}
    <p class="secsub">How the composer treats the Enter key.</p>
    <div class="setgroup">
      <div class="setrow">
        <span class="lbl" id="enter-l">Enter key on a computer</span>
        <span class="hint">${sends ? "Shift+Enter adds a line." : "Ctrl+Enter sends."}</span>
        <span class="ctl"><span class="seg sunk" role="tablist" aria-labelledby="enter-l"><button type="button" role="tab" data-enter="sends" aria-selected="${sends}">sends</button><button type="button" role="tab" data-enter="line" aria-selected="${!sends}">adds a line</button></span></span>
      </div>
      <div class="setrow"><span class="lbl">On a phone</span><span class="hint">Enter always adds a line, and only Send sends, so a stray tap never sends half a message.</span></div>
    </div>`;
}

// ------------------------------------------------------------------- events

/** Set a slider's track fill (--fill, as the stylesheet asks) and its shown value. */
function fill(slider) {
  const v = Number(slider.value);
  const pct = ((v - Number(slider.min)) / (Number(slider.max) - Number(slider.min))) * 100;
  slider.style.setProperty("--fill", `${pct.toFixed(1)}%`);
  slider.setAttribute("aria-valuetext", num(v, 2));
  const val = slider.closest(".setrow")?.querySelector(".val");
  if (val) val.textContent = num(v, 2);
}

async function newProfile(opener) {
  const p = await attempt(() => api("POST", "/api/profiles", { name: "New profile", temperature: 1, maxTokens: 1000 }));
  if (!p) return;
  const settings = await attempt(() => api("GET", "/api/state"));
  if (settings) Object.assign(state, settings);
  else state.profiles.push(p);
  ui.fresh.add(p.id);
  go(`#/settings/profile/${p.id}`);
  requestAnimationFrame(() => $("pname")?.select());
  void opener;
}

async function deleteProfile(opener) {
  const p = profileOf(ui.profileId);
  const jobs = [p.id === state.settings.rpProfileId ? "story replies" : "", p.id === state.settings.agentProfileId ? "the agent" : ""].filter(Boolean);
  const ok = await confirmDialog({
    title: `Delete “${p.name}”?`,
    body: jobs.length ? `It's what ${jobs.join(" and ")} use${jobs.length === 1 ? "s" : ""} now. Pick another profile for ${jobs.length === 1 ? "that" : "those"} afterwards. Messages it wrote stay.` : "Nothing uses it. Messages it wrote stay.",
    confirm: "delete profile",
    opener,
  });
  if (!ok) return;
  if (!(await attempt(() => api("DELETE", `/api/profiles/${p.id}`)))) return;
  const fresh = await attempt(() => api("GET", "/api/state"));
  if (fresh) Object.assign(state, fresh);
  go("#/settings/connections");
}

async function testProfile() {
  const p = profileOf(ui.profileId);
  if (!p?.model || ui.tests[p.id] === "running") return;
  clearTimeout(profileTimer);
  if (Object.keys(pending).length) await api("PATCH", `/api/profiles/${p.id}`, { ...pending }).catch(() => {});
  for (const k of Object.keys(pending)) delete pending[k];
  ui.tests[p.id] = "running";
  redraw();
  try {
    const r = await api("POST", `/api/profiles/${p.id}/test`, {});
    ui.tests[p.id] = r;
    state.providers = r.providers;
  } catch (error) {
    ui.tests[p.id] = { ok: false, message: error.message };
  }
  if (ui.section === "profile" && ui.profileId === p.id) redraw();
  else renderNav();
}

async function setEnter(sends) {
  const settings = await attempt(() => api("PATCH", "/api/settings", { enterSends: sends }));
  if (!settings) return;
  state.settings = settings;
  redraw();
}

export function wireSettings() {
  const view = $("view-settings");

  view.addEventListener("click", async (e) => {
    const t = e.target;
    const btn = t.closest("button, a");
    if (!btn || !view.contains(btn)) return;
    if (btn.getAttribute("aria-disabled") === "true") {
      e.preventDefault();
      return;
    }
    if (btn.dataset.assign) {
      const job = btn.dataset.assign;
      if (!state.profiles.length) return newProfile(btn);
      return openPick(btn, {
        label: job === "story" ? "Profile for story replies" : "Profile for the agent",
        options: state.profiles.map((p) => [p.id, p.name, `${p.model || "no model yet"} · ${PROVIDER_NAME[p.provider]}`]),
        selected: job === "story" ? state.settings.rpProfileId : state.settings.agentProfileId,
        onPick: (id) => assign(job, id),
      });
    }
    if (btn.hasAttribute("data-region")) {
      return openPick(btn, {
        label: "Vertex AI region",
        options: (state.regions ?? []).map(([id, where]) => [id, id, where]),
        selected: ui.draft.location,
        onPick: (id) => {
          ui.draft.location = id;
          redraw();
          $("vreg-b")?.focus();
        },
      });
    }
    if (btn.hasAttribute("data-new-profile")) return newProfile(btn);
    if (btn.dataset.fix) return openSetup(btn.dataset.fix);
    if (btn.dataset.setup) return openSetup(btn.dataset.setup);
    if (btn.hasAttribute("data-setup-cancel")) {
      const id = ui.setup;
      ui.setup = null;
      ui.draft = {};
      redraw();
      return $("settings-body").querySelector(`[data-setup="${id}"]`)?.focus();
    }
    if (btn.dataset.setupSave) return saveSetup(btn.dataset.setupSave);
    if (btn.dataset.test) return testProvider(btn.dataset.test);
    // the profile editor
    if (btn.dataset.provider) {
      const p = profileOf(ui.profileId);
      if (p.provider === btn.dataset.provider) return;
      // Models differ between providers: keep this one for switching back, and start from the other's.
      ui.lastModel[`${p.id}:${p.provider}`] = p.model;
      saveProfile({ provider: btn.dataset.provider, model: ui.lastModel[`${p.id}:${btn.dataset.provider}`] ?? "" }, true);
      loadModels(btn.dataset.provider);
      return redraw();
    }
    if (btn.id === "model-b") return openPicker(btn);
    if (btn.hasAttribute("data-more")) {
      ui.more = !ui.more;
      btn.setAttribute("aria-expanded", String(ui.more));
      $("more-ctl").hidden = !ui.more;
      return;
    }
    if (btn.dataset.effort) {
      saveProfile({ reasoningEffort: btn.dataset.effort === "off" ? null : btn.dataset.effort }, true);
      return redraw();
    }
    if (btn.hasAttribute("data-test-profile")) return testProfile();
    if (btn.hasAttribute("data-delete-profile")) return deleteProfile(btn);
    // look
    if (btn.dataset.photo) return saveBackground({ photo: btn.dataset.photo }, true);
    if (btn.dataset.finish) return saveBackground({ finish: btn.dataset.finish }, true);
    if (btn.hasAttribute("data-readable")) return saveBackground(readable(), true);
    if (btn.dataset.removePhoto) {
      const photo = state.photos.find((p) => p.id === btn.dataset.removePhoto);
      const ok = await confirmDialog({ title: `Remove “${photo?.name ?? "this photo"}”?`, body: "It's deleted from your server. The background goes back to none.", confirm: "remove photo", opener: btn });
      if (!ok) return;
      const done = await attempt(() => api("DELETE", `/api/photos/${photo.id}`));
      if (!done) return;
      state.photos = state.photos.filter((p) => p.id !== photo.id);
      state.settings = done.settings;
      applyBackground(state.settings.background);
      redraw();
      return $("settings-body").querySelector('[data-photo="none"]')?.focus();
    }
    // agent and typing
    if (btn.dataset.agentOpen) return openAgentTab(btn.dataset.agentOpen);
    if (btn.dataset.enter) return setEnter(btn.dataset.enter === "sends");
  });

  view.addEventListener("input", (e) => {
    const t = e.target;
    if (t.classList.contains("slider")) fill(t);
    if (t.dataset.bg) return saveBackground({ [t.dataset.bg]: Number(t.value) });
    if (t.dataset.field) {
      const v = Number(t.value);
      // Top P at 1 and min P at 0 are the model's own defaults: send nothing for them.
      const value = (t.dataset.field === "topP" && v === 1) || (t.dataset.field === "minP" && v === 0) ? null : v;
      saveProfile({ [t.dataset.field]: value });
      if (t.dataset.field !== "temperature") $("more-sum").innerHTML = moreSummary(profileOf(ui.profileId));
      return;
    }
    if (t.id === "pname") {
      if (t.value.trim()) saveProfile({ name: t.value.trim() });
      return;
    }
    if (t.id === "maxt") {
      const n = Number(t.value.replace(/[^\d]/g, ""));
      if (n >= 1 && n <= 200000) {
        $("maxt-words").textContent = words(n);
        saveProfile({ maxTokens: n });
      }
      return;
    }
    if (t.id === "xjson") {
      const p = profileOf(ui.profileId);
      const check = jsonCheck(t.value);
      $("json-stat").innerHTML = `<span class="dot ${check.dot}"></span>${check.text}`;
      if (check.ok) {
        delete ui.json[p.id];
        saveProfile({ extraParams: t.value.trim() });
      } else ui.json[p.id] = t.value;
      $("more-sum").innerHTML = moreSummary(p);
      return;
    }
    if (t.id === "nkey") {
      ui.draft.nanoKey = t.value;
      view.querySelector('[data-setup-save="nanogpt"]')?.setAttribute("aria-disabled", String(!t.value.trim()));
      return;
    }
    if (t.id === "vproj") {
      ui.draft.project = t.value;
      view.querySelector('[data-setup-save="vertex"]')?.setAttribute("aria-disabled", String(!t.value.trim() || !(ui.draft.keyName ?? providers().vertex?.keyName)));
    }
  });

  view.addEventListener("change", async (e) => {
    const t = e.target;
    if (t.id === "maxt") {
      const p = profileOf(ui.profileId);
      t.value = fmt(p.maxTokens);
      return;
    }
    if (t.id === "pname" && !t.value.trim()) {
      t.value = profileOf(ui.profileId).name;
      return;
    }
    if (t.id === "photo-file" && t.files?.[0]) {
      addPhoto(t.files[0]);
      t.value = "";
      return;
    }
    if (t.id === "vkey-file" && t.files?.[0]) {
      const file = t.files[0];
      t.value = "";
      if (file.size > 64 * 1024) return showError("That file is too big to be a service account key.");
      ui.draft.keyJson = await file.text();
      ui.draft.keyName = file.name;
      redraw();
      $("vkey-file")?.focus();
    }
  });

  view.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.id === "nkey" && e.target.value.trim()) saveSetup("nanogpt");
  });

  // The model list: type to filter, arrows to move, Enter to pick.
  const dlg = $("model-picker");
  dlg.addEventListener("input", (e) => {
    if (e.target.id !== "model-q") return;
    picker.q = e.target.value;
    picker.active = picker.q ? 0 : -1;
    renderPicker();
  });
  dlg.addEventListener("keydown", (e) => {
    if (e.target.id !== "model-q") return;
    const n = Math.min(picker.list.length, 300);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!n) return;
      picker.active = e.key === "ArrowDown" ? (picker.active + 1) % n : (picker.active - 1 + n) % n;
      renderPicker();
      $(`mopt-${picker.active}`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = picker.list[picker.active] ?? (picker.list.length === 1 ? picker.list[0] : null);
      if (pick) pickModel(pick.id);
    }
  });
  dlg.addEventListener("click", (e) => {
    const li = e.target.closest("[data-model]");
    if (li) pickModel(li.dataset.model);
  });
}
