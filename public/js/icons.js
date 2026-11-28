/**
 * The icons, drawn as on the design boards. Each is decorative
 * (aria-hidden): the button around it carries the words.
 */

const svg = (size, body, { stroke = "currentColor", width = 1.8, fill = "none", style = "" } = {}) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="${fill === "none" ? stroke : "none"}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${style ? ` style="${style}"` : ""}>${body}</svg>`;

const glow = (rgba) => `filter: drop-shadow(0 0 3px ${rgba})`;

export const icon = {
  plus: (s = 18) => svg(s, '<path d="M12 5v14M5 12h14"/>', { width: 2 }),
  cards: (s = 22) => svg(s, '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>', { stroke: "#C9A6FF", style: glow("rgba(168,108,255,0.8)") }),
  prompts: (s = 22, lit = true) =>
    svg(s, '<rect x="4" y="4" width="16" height="4" rx="1.5"/><rect x="4" y="10" width="16" height="4" rx="1.5"/><rect x="4" y="16" width="10" height="4" rx="1.5"/>', {
      stroke: "#8FD2FF",
      style: lit ? glow("rgba(77,184,255,0.8)") : "",
    }),
  settings: (s = 22) => svg(s, '<circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>'),
  eye: (s = 20) => svg(s, '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>', { stroke: "#8FD2FF" }),
  sliders: (s = 20) => svg(s, '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
  copy: (s = 17) => svg(s, '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
  check: (s = 17) => svg(s, '<path d="M5 12.5l4.5 4.5L19 7"/>', { width: 2 }),
  edit: (s = 17) => svg(s, '<path d="M4 20h4L19 9l-4-4L4 16Z"/><path d="M13.5 6.5l4 4"/>'),
  trash: (s = 17) => svg(s, '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  left: (s = 16) => svg(s, '<path d="M15 6l-6 6 6 6"/>', { width: 2 }),
  right: (s = 16) => svg(s, '<path d="M9 6l6 6-6 6"/>', { width: 2 }),
  down: (s = 18) => svg(s, '<path d="M6 9l6 6 6-6"/>', { width: 2 }),
  caret: () => svg(10, '<path d="M6 9l6 6 6-6"/>', { width: 3 }),
  branch: (s = 17) => svg(s, '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-10.5 8.5"/>'),
  rewind: (s = 17) => svg(s, '<path d="M11 6l-6 6 6 6M19 6l-6 6 6 6"/>'),
  regen: (s = 17) => svg(s, '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>', { stroke: "#8FD2FF" }),
  send: (s = 20) => svg(s, '<path d="M4 12l16-8-6 16-2.5-6.5Z"/>', { stroke: "#062A44", width: 2 }),
  stop: (s = 18) => svg(s, '<rect x="6" y="6" width="12" height="12" rx="2"/>', { width: 2 }),
  go: (s = 16) => svg(s, '<path d="M5 12h12M13 6l6 6-6 6"/>', { width: 2 }),
  close: (s = 20) => svg(s, '<path d="M6 6l12 12M18 6L6 18"/>'),
  menu: (s = 22) => svg(s, '<path d="M4 7h16M4 12h16M4 17h11"/>', { width: 1.9 }),
  more: (s = 22) => svg(s, '<circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/>', { fill: "currentColor" }),
  folder: (s = 20, card = null) => {
    const blue = card && !card.isCharacter && !card.isPersona;
    return svg(s, '<path d="M3 7.5a2 2 0 0 1 2-2h4.2l2 2.2H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>', {
      stroke: blue ? "#8FD2FF" : "#C9A6FF",
      style: `filter: drop-shadow(0 0 5px ${blue ? "rgba(77,184,255,0.8)" : "rgba(168,108,255,0.8)"})`,
    });
  },
  text: (s = 18) => svg(s, '<path d="M5 6h14M5 10h14M5 14h9"/>'),
  history: (s = 18) => svg(s, '<path d="M4 6h16M4 10h12M4 14h16M4 18h9"/>', { stroke: "var(--ink-3)" }),
  main: (s = 18) => svg(s, '<path d="M12 3l2.4 5 5.6.8-4 3.9.9 5.5L12 15.6 7.1 18.2 8 12.7 4 8.8 9.6 8Z"/>', { stroke: "#C9A6FF", style: glow("rgba(168,108,255,0.7)") }),
  search: (s = 18) => svg(s, '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
  import: (s = 16) => svg(s, '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>', { width: 2 }),
  plug: (s = 20) => svg(s, '<path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0z"/><path d="M12 16v5"/>', { width: 1.9 }),
  picture: (s = 20) => svg(s, '<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M3.5 15l5-4.5 4 3.5 3-2.5 5 4"/><circle cx="15.5" cy="9" r="1.6"/>', { width: 1.9 }),
  spark: (s = 20) => svg(s, '<path d="M12 3C12.9 8.1 15.9 11.1 21 12C15.9 12.9 12.9 15.9 12 21C11.1 15.9 8.1 12.9 3 12C8.1 11.1 11.1 8.1 12 3Z"/>', { width: 1.9 }),
  keyboard: (s = 20) => svg(s, '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>', { width: 1.9 }),
  lock: (s = 20) => svg(s, '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>', { width: 1.9 }),
  reset: (s = 16) => svg(s, '<path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 4v4.5h4.5"/>', { width: 2 }),
  tick: (s = 14) => svg(s, '<path d="M5 12.5l4.5 4.5L19 7.5"/>', { width: 3 }),
  warn: (s = 14) => svg(s, '<path d="M12 3l10 18H2Z"/><path d="M12 10v5M12 18h.01"/>', { width: 2.2 }),
};
