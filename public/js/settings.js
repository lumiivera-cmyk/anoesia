/**
 * Settings (connection profiles and the main prompt) and the prompt preview.
 */

import { $, api, attempt, escapeHtml, loadState, openDialog, state } from "./core.js";

const DEFAULT_MAIN_PROMPT =
  "This is a roleplay between {{user}} and you, the narrator. You write the world and everyone in it: {{cast}}. {{user}} is written only by the user: never write their words, actions or thoughts.";

/** Model lists already loaded, by provider. */
const models = {};

export function openSettings() {
  renderSettings();
  openDialog("settings-dialog");
}

function renderSettings() {
  const keys = [state.apiKeySet ? "nanoGPT key is set" : "No nanoGPT key yet (NANOGPT_API_KEY in .env)", state.vertexReady ? "Vertex AI is set up" : "Vertex AI isn't set up"];
  $("key-status").textContent = keys.join(" · ");
  $("rp-profile").innerHTML = state.profiles.length
    ? state.profiles.map((p) => `<option value="${p.id}" ${p.id === state.settings.rpProfileId ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")
    : `<option value="">Make a profile first</option>`;
  $("profile-list").innerHTML = state.profiles.map(profileHtml).join("");
  $("main-prompt").value = state.settings.mainPrompt;
}

function profileHtml(p) {
  const efforts = ["", "none", "low", "medium", "high"];
  return `<details class="profile" data-id="${p.id}">
    <summary><strong>${escapeHtml(p.name)}</strong> <span class="muted small">${escapeHtml(p.model || "no model yet")}</span></summary>
    <div class="grid">
      <label class="field">Name <input name="name" value="${escapeHtml(p.name)}" /></label>
      <label class="field">Provider <select name="provider">
        <option value="nanogpt" ${p.provider === "nanogpt" ? "selected" : ""}>nanoGPT</option>
        <option value="vertex" ${p.provider === "vertex" ? "selected" : ""}>Google Vertex AI</option></select></label>
    </div>
    <label class="field">Model <input name="model" list="models-${p.id}" value="${escapeHtml(p.model)}" placeholder="Type or pick a model id" /></label>
    <datalist id="models-${p.id}"></datalist>
    <div class="grid">
      <label class="field">Temperature <input name="temperature" type="number" step="0.05" min="0" max="2" value="${p.temperature}" /></label>
      <label class="field">Max tokens <input name="maxTokens" type="number" min="1" value="${p.maxTokens}" /></label>
      <label class="field">Top P <input name="topP" type="number" step="0.01" min="0" max="1" value="${p.topP ?? ""}" placeholder="model default" /></label>
      <label class="field">Min P <input name="minP" type="number" step="0.01" min="0" max="1" value="${p.minP ?? ""}" placeholder="model default" /></label>
      <label class="field">Reasoning <select name="reasoningEffort">${efforts
        .map((e) => `<option value="${e}" ${(p.reasoningEffort ?? "") === e ? "selected" : ""}>${e || "model default"}</option>`)
        .join("")}</select></label>
    </div>
    <label class="field">Extra parameters (JSON) <input name="extraParams" value="${escapeHtml(p.extraParams)}" placeholder='{"top_k": 40}' /></label>
    <div class="row"><span class="muted small" data-status></span><span class="spacer"></span><button type="button" class="button danger" data-delete-profile>Delete</button></div>
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
    status.textContent = "Saved";
    details.querySelector("summary").innerHTML = `<strong>${escapeHtml(saved.name)}</strong> <span class="muted small">${escapeHtml(saved.model || "no model yet")}</span>`;
    if (input.name === "provider") loadModels(details);
    if (input.name === "name") renderRpPicker();
  } catch (error) {
    status.textContent = error.message;
  }
}

function renderRpPicker() {
  $("rp-profile").innerHTML = state.profiles.map((p) => `<option value="${p.id}" ${p.id === state.settings.rpProfileId ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("");
}

// -------------------------------------------------------------- preview

let preview = null;
let previewTab = "blocks";

export async function openPreview() {
  if (!state.chatId) return;
  preview = await attempt(() => api("GET", `/api/chats/${state.chatId}/preview`));
  if (!preview) return;
  renderPreview();
  openDialog("preview-dialog");
}

function renderPreview() {
  $("preview-summary").textContent = `${preview.blocks.length} blocks, sent as ${preview.messages.length} messages, about ${preview.approxTokens} tokens. Macros are filled in. (Random macros may roll differently when it's really sent.)`;
  for (const t of document.querySelectorAll("[data-preview-tab]")) t.classList.toggle("active", t.dataset.previewTab === previewTab);
  const items = previewTab === "blocks" ? preview.blocks : preview.messages.map((m, i) => ({ ...m, label: `Message ${i + 1}` }));
  $("preview-body").innerHTML = items
    .map(
      (b) => `<div class="block"><div class="block-head"><span class="label">${escapeHtml(b.label)}${b.depth !== undefined ? ` <span class="muted small">(depth ${b.depth})</span>` : ""}</span><span class="role ${b.role}">${b.role}</span><span class="muted small">~${Math.round(b.content.length / 4)}</span></div><pre>${escapeHtml(b.content)}</pre></div>`,
    )
    .join("");
}

export function wireSettings() {
  $("open-settings").addEventListener("click", openSettings);
  $("open-preview").addEventListener("click", openPreview);
  for (const t of document.querySelectorAll("[data-preview-tab]"))
    t.addEventListener("click", () => {
      previewTab = t.dataset.previewTab;
      renderPreview();
    });
  $("rp-profile").addEventListener("change", async (e) => {
    const settings = await attempt(() => api("PATCH", "/api/settings", { rpProfileId: e.target.value }));
    if (settings) state.settings = settings;
  });
  $("new-profile").addEventListener("click", async () => {
    const p = await attempt(() => api("POST", "/api/profiles", { name: `Profile ${state.profiles.length + 1}` }));
    if (!p) return;
    await loadState();
    renderSettings();
    const details = $("profile-list").querySelector(`[data-id="${p.id}"]`);
    details.open = true;
    loadModels(details);
  });
  $("profile-list").addEventListener("change", saveProfileField);
  $("profile-list").addEventListener("toggle", (e) => e.target.open && loadModels(e.target), true);
  $("profile-list").addEventListener("click", async (e) => {
    if (!e.target.closest("[data-delete-profile]")) return;
    const details = e.target.closest(".profile");
    if (!confirm("Delete this profile?")) return;
    await attempt(() => api("DELETE", `/api/profiles/${details.dataset.id}`));
    await loadState();
    renderSettings();
  });
  $("save-main-prompt").addEventListener("click", async () => {
    const settings = await attempt(() => api("PATCH", "/api/settings", { mainPrompt: $("main-prompt").value }));
    if (settings) state.settings = settings;
  });
  $("reset-main-prompt").addEventListener("click", () => {
    $("main-prompt").value = DEFAULT_MAIN_PROMPT;
  });
}
