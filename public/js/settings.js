/**
 * Settings: the background (photo, finish, tint, dim, window, and "back to
 * readable"), connection profiles, and the main prompt. Not designed yet,
 * so it's built from the shared components.
 */

import { $, api, attempt, escapeHtml, loadState, showError, state } from "./core.js";
import { icon } from "./icons.js";
import { closeOverlay, confirmDialog, openOverlay } from "./overlay.js";
import { applyBackground, FINISHES, preparePhoto, READABLE } from "./theme.js";

const DEFAULT_MAIN_PROMPT =
  "This is a roleplay between {{user}} and you, the narrator. You write the world and everyone in it: {{cast}}. {{user}} is written only by the user: never write their words, actions or thoughts.";

/** Model lists already loaded, by provider. */
const models = {};

export function openSettings(opener) {
  render();
  openOverlay($("settings-dialog"), { opener, focus: "[data-close]" });
}

const windowDefault = () => (matchMedia("(max-width: 899px)").matches ? 0.7 : 0.72);

function render() {
  const bg = state.settings.background;
  const win = bg.window ?? windowDefault();
  const photos = state.photos ?? [];
  const current = photos.find((p) => p.id === bg.photo);
  $("settings-dialog").innerHTML = `
    <header class="dlg-head"><h2 class="disp" id="settings-title">Settings</h2><button type="button" class="ghost press ib" data-close aria-label="Close">${icon.close()}</button></header>
    <div class="dlg-body scroll">
      <section aria-labelledby="bg-h">
        <h3 class="eyebrow" id="bg-h">background</h3>
        <div role="radiogroup" aria-label="Photo" class="photo-grid">
            <button type="button" role="radio" class="photo-pick press none" aria-checked="${bg.photo === "none"}" data-photo="none"><span class="ph-none" aria-hidden="true"></span><span class="ph-name">none</span></button>${photos
              .map(
                (p) => `<button type="button" role="radio" class="photo-pick press" aria-checked="${bg.photo === p.id}" data-photo="${p.id}">
              <img src="${escapeHtml(p.url)}" alt="" loading="lazy" style="object-position:${escapeHtml(p.position)}" /><span class="ph-name">${escapeHtml(p.name)}</span></button>`,
              )
              .join("")}
          <label class="photo-add press">${icon.plus(20)}<span>add a photo</span><input type="file" accept="image/jpeg,image/png,image/webp" id="photo-file" class="sr-file" /></label>
        </div>
        <p class="meta small" id="photo-status" role="status">${current ? "" : photos.length ? "" : "Add a photo of your own to sit behind the app. It's kept on your server, not shared."}</p>
        ${current ? `<button type="button" class="btn btn-quiet-danger press" data-remove-photo="${current.id}">${icon.trash()} remove “${escapeHtml(current.name)}”</button>` : ""}
        <div class="set-row"><span class="set-label" id="finish-l">finish</span>
          <div class="seg sunk" role="radiogroup" aria-labelledby="finish-l">${Object.entries(FINISHES)
            .map(([k, f]) => `<button type="button" role="radio" aria-checked="${bg.finish === k}" data-finish="${k}" title="${f.hint}">${f.label}</button>`)
            .join("")}</div></div>
        <p class="meta small">How the lacquer panes meet the photo: ${escapeHtml(FINISHES[bg.finish].hint)}.</p>
        ${slider("tint", "tint", bg.tint, 0, 1, 0.05, "how far the photo's colour tints the lacquer")}
        <div class="readable-group">
          ${slider("dim", "dim", bg.dim, 0, 0.8, 0.05, "darkens the photo")}
          ${slider("window", "window", win, 0.3, 0.95, 0.01, "how dark the reading column is")}
          <button type="button" class="btn raised press" data-readable>back to readable</button>
        </div>
        <p class="meta small">Low dim and window can make the story hard to read over a bright photo. Back to readable puts both back.</p>
      </section>

      <section aria-labelledby="conn-h">
        <h3 class="eyebrow" id="conn-h">connections</h3>
        <p class="meta small">${[state.apiKeySet ? "nanoGPT key is set" : "No nanoGPT key yet (NANOGPT_API_KEY in .env)", state.vertexReady ? "Vertex AI is set up" : "Vertex AI isn't set up"].join(" · ")}</p>
        <label class="field-label" for="rp-profile">writes replies</label>
        <div class="sunk well select-well"><select id="rp-profile" class="inp">${
          state.profiles.length
            ? state.profiles.map((p) => `<option value="${p.id}" ${p.id === state.settings.rpProfileId ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")
            : `<option value="">make a profile first</option>`
        }</select></div>
        <div id="profile-list">${state.profiles.map(profileHtml).join("")}</div>
        <button type="button" class="btn raised press" id="new-profile">${icon.plus(16)} new profile</button>
      </section>

      <section aria-labelledby="main-h">
        <h3 class="eyebrow" id="main-h">main prompt</h3>
        <p class="meta small">The first block of every chat's prompt. It's also on each chat's prompts page.</p>
        <label class="sr" for="main-prompt">Main prompt</label>
        <textarea id="main-prompt" class="sunk ftext" rows="5">${escapeHtml(state.settings.mainPrompt)}</textarea>
        <div class="row-end"><button type="button" class="btn ghost press" id="reset-main-prompt">reset</button><button type="button" class="btn btn-primary press" id="save-main-prompt">save</button></div>
      </section>
    </div>`;
}

function slider(key, label, value, min, max, step, hint) {
  return `<div class="set-row slider-row">
    <label class="set-label" for="bg-${key}">${label}</label>
    <input type="range" class="range" id="bg-${key}" data-bg="${key}" min="${min}" max="${max}" step="${step}" value="${value}" aria-describedby="bg-${key}-h" />
    <output class="set-val" for="bg-${key}">${Number(value).toFixed(2)}</output>
    <span class="sr" id="bg-${key}-h">${hint}</span></div>`;
}

function profileHtml(p) {
  const efforts = ["", "none", "low", "medium", "high"];
  return `<details class="profile raised" data-id="${p.id}">
    <summary><span class="n">${escapeHtml(p.name)}</span> <span class="meta">${escapeHtml(p.model || "no model yet")}</span></summary>
    <div class="grid">
      <label class="field-label">name<span class="sunk well"><input class="inp" name="name" value="${escapeHtml(p.name)}" /></span></label>
      <label class="field-label">provider<span class="sunk well select-well"><select class="inp" name="provider">
        <option value="nanogpt" ${p.provider === "nanogpt" ? "selected" : ""}>nanoGPT</option>
        <option value="vertex" ${p.provider === "vertex" ? "selected" : ""}>Google Vertex AI</option></select></span></label>
    </div>
    <label class="field-label">model<span class="sunk well"><input class="inp" name="model" list="models-${p.id}" value="${escapeHtml(p.model)}" placeholder="type or pick a model id" /></span></label>
    <datalist id="models-${p.id}"></datalist>
    <div class="grid">
      <label class="field-label">temperature<span class="sunk well"><input class="inp" name="temperature" type="number" step="0.05" min="0" max="2" value="${p.temperature}" /></span></label>
      <label class="field-label">max tokens<span class="sunk well"><input class="inp" name="maxTokens" type="number" min="1" value="${p.maxTokens}" /></span></label>
      <label class="field-label">top p<span class="sunk well"><input class="inp" name="topP" type="number" step="0.01" min="0" max="1" value="${p.topP ?? ""}" placeholder="model default" /></span></label>
      <label class="field-label">min p<span class="sunk well"><input class="inp" name="minP" type="number" step="0.01" min="0" max="1" value="${p.minP ?? ""}" placeholder="model default" /></span></label>
      <label class="field-label">reasoning<span class="sunk well select-well"><select class="inp" name="reasoningEffort">${efforts
        .map((e) => `<option value="${e}" ${(p.reasoningEffort ?? "") === e ? "selected" : ""}>${e || "model default"}</option>`)
        .join("")}</select></span></label>
    </div>
    <label class="field-label">extra parameters (JSON)<span class="sunk well"><input class="inp" name="extraParams" value="${escapeHtml(p.extraParams)}" placeholder='{"top_k": 40}' /></span></label>
    <div class="row-end"><span class="meta" data-status role="status"></span><button type="button" class="btn btn-quiet-danger press" data-delete-profile>${icon.trash(16)} delete profile</button></div>
  </details>`;
}

async function loadModels(details) {
  const provider = details.querySelector('[name="provider"]').value;
  const list = details.querySelector("datalist");
  if (!models[provider]) {
    try {
      models[provider] = await api("GET", `/api/models?provider=${provider}`);
    } catch (error) {
      details.querySelector("[data-status]").textContent = `Couldn't load models: ${error.message}`;
      return;
    }
  }
  list.innerHTML = models[provider].map((m) => `<option value="${escapeHtml(m.id)}"></option>`).join("");
}

async function saveProfileField(event) {
  const details = event.target.closest(".profile");
  const input = event.target;
  if (!details || !input.name) return;
  const status = details.querySelector("[data-status]");
  try {
    const value = input.type === "number" && input.value !== "" ? Number(input.value) : input.value;
    const saved = await api("PATCH", `/api/profiles/${details.dataset.id}`, { [input.name]: input.name === "reasoningEffort" && !value ? null : value });
    Object.assign(
      state.profiles.find((p) => p.id === saved.id),
      saved,
    );
    status.textContent = "saved";
    details.querySelector("summary").innerHTML = `<span class="n">${escapeHtml(saved.name)}</span> <span class="meta">${escapeHtml(saved.model || "no model yet")}</span>`;
    if (input.name === "provider") loadModels(details);
  } catch (error) {
    status.textContent = error.message;
  }
}

let bgTimer = 0;
function saveBackground(change, redraw = false) {
  Object.assign(state.settings.background, change);
  applyBackground(state.settings.background);
  clearTimeout(bgTimer);
  bgTimer = setTimeout(async () => {
    const saved = await attempt(() => api("PATCH", "/api/settings", { background: change.window === undefined ? state.settings.background : { ...state.settings.background, window: change.window } }));
    if (saved) state.settings.background = saved.background;
  }, 250);
  if (redraw) {
    const focused = document.activeElement?.dataset;
    const sel = focused?.photo ? `[data-photo="${focused.photo}"]` : focused?.finish ? `[data-finish="${focused.finish}"]` : focused?.readable !== undefined ? "[data-readable]" : null;
    const scroll = $("settings-dialog").querySelector(".dlg-body").scrollTop;
    render();
    $("settings-dialog").querySelector(".dlg-body").scrollTop = scroll;
    if (sel) $("settings-dialog").querySelector(sel)?.focus();
  }
}

/** Upload a picked photo, then show it. */
async function addPhoto(file) {
  const status = $("photo-status");
  status.textContent = "Adding the photo…";
  try {
    const { blob, tint, name } = await preparePhoto(file);
    const q = new URLSearchParams({ name, tint, position: "50% 50%" });
    const response = await fetch(`api/photos?${q}`, { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && data.login) location.href = "login";
    if (!response.ok) throw new Error(data.error || "Couldn't add the photo.");
    state.photos = [...(state.photos ?? []), data];
    saveBackground({ photo: data.id }, true);
    $("settings-dialog").querySelector(`[data-photo="${data.id}"]`)?.focus();
  } catch (error) {
    status.textContent = "";
    showError(error.message);
  }
}

export function wireSettings() {
  const d = $("settings-dialog");
  d.addEventListener("change", async (e) => {
    if (e.target.id === "agent-profile") {
      const settings = await attempt(() => api("PATCH", "/api/settings", { agentProfileId: e.target.value }));
      if (settings) state.settings = settings;
      return;
    }
    if (e.target.id !== "photo-file" || !e.target.files?.[0]) return;
    addPhoto(e.target.files[0]);
    e.target.value = "";
  });
  d.addEventListener("click", async (e) => {
    const t = e.target;
    if (t.closest("[data-close]")) return closeOverlay(d);
    const photo = t.closest("[data-photo]");
    if (photo) return saveBackground({ photo: photo.dataset.photo }, true);
    const finish = t.closest("[data-finish]");
    if (finish) return saveBackground({ finish: finish.dataset.finish }, true);
    if (t.closest("[data-readable]")) return saveBackground({ ...READABLE }, true);
    const rm = t.closest("[data-remove-photo]");
    if (rm) {
      const photo = state.photos.find((p) => p.id === rm.dataset.removePhoto);
      const ok = await confirmDialog({ title: `Remove “${photo?.name ?? "this photo"}”?`, body: "It's deleted from your server. The background goes back to none.", confirm: "remove photo", keep: "keep it", opener: rm });
      if (!ok) return;
      const done = await attempt(() => api("DELETE", `/api/photos/${rm.dataset.removePhoto}`));
      if (!done) return;
      state.photos = state.photos.filter((p) => p.id !== rm.dataset.removePhoto);
      state.settings = done.settings;
      applyBackground(state.settings.background);
      render();
      d.querySelector('[data-photo="none"]')?.focus();
      return;
    }
    if (t.closest("#new-profile")) {
      const p = await attempt(() => api("POST", "/api/profiles", { name: `Profile ${state.profiles.length + 1}` }));
      if (!p) return;
      await loadState();
      render();
      const details = d.querySelector(`.profile[data-id="${p.id}"]`);
      details.open = true;
      details.querySelector("summary").focus();
      loadModels(details);
      return;
    }
    const del = t.closest("[data-delete-profile]");
    if (del) {
      const details = del.closest(".profile");
      const ok = await confirmDialog({ title: "Delete this profile?", body: "Chats keep their messages; replies just won't be written with it any more.", confirm: "delete profile", keep: "keep it", opener: del });
      if (!ok) return;
      await attempt(() => api("DELETE", `/api/profiles/${details.dataset.id}`));
      await loadState();
      render();
      return;
    }
    if (t.closest("#save-main-prompt")) {
      const settings = await attempt(() => api("PATCH", "/api/settings", { mainPrompt: $("main-prompt").value }));
      if (settings) {
        state.settings = settings;
        t.closest("button").textContent = "saved";
      }
      return;
    }
    if (t.closest("#reset-main-prompt")) $("main-prompt").value = DEFAULT_MAIN_PROMPT;
  });
  d.addEventListener("input", (e) => {
    const key = e.target.dataset.bg;
    if (!key) return;
    const value = Number(e.target.value);
    e.target.parentElement.querySelector("output").textContent = value.toFixed(2);
    saveBackground({ [key]: value });
  });
  d.addEventListener("change", async (e) => {
    if (e.target.id === "rp-profile") {
      const settings = await attempt(() => api("PATCH", "/api/settings", { rpProfileId: e.target.value }));
      if (settings) state.settings = settings;
      return;
    }
    if (e.target.closest(".profile")) saveProfileField(e);
  });
  d.addEventListener("toggle", (e) => e.target.open && e.target.classList?.contains("profile") && loadModels(e.target), true);
}
