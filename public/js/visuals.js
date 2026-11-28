/**
 * Visuals: HTML a story reply draws, like a scene map or a status panel.
 *
 * A reply can hold a block of HTML (a `<div>`, `<table>`, `<svg>`,
 * `<details>`, `<figure>`, `<section>` or `<aside>` that starts a line, up to
 * its matching close tag, or a ```html fence). The chat draws it as a
 * picture instead of showing the markup. Everything else in the reply stays
 * plain text, as before.
 *
 * Drawing is safe by allowlist (`sanitizeVisual`, browser only): known tags
 * and a few attributes stay, inline styles stay unless they could load
 * something (`url(`, `@import`, `image-set`, escapes) or pin to the screen
 * (`position: fixed/sticky`). Scripts, event handlers, links, images,
 * frames, forms and ids outside SVG gradients are dropped, so a visual can't
 * run code, fetch anything or reach into the app's page. The chat also
 * wraps it in a box that keeps its absolute positioning and layers inside.
 *
 * The prompt doesn't need the markup again: `shortenVisuals` swaps a visual
 * for its words (`[visual: ...]`). The prompt keeps only the latest visual
 * whole, so the model can redraw it when asked, and the Story so far fold
 * always reads the words. The pure functions here run on the server too.
 */

const OPENERS = ["div", "table", "svg", "details", "figure", "section", "aside"];
const START = new RegExp(`(^|\\n)[ \\t]*(?:\`\`\`html[ \\t]*\\n|<(${OPENERS.join("|")})(?=[\\s>/]))`, "gi");

/**
 * The text in order as plain parts and visual parts:
 * `{ kind: "text" | "visual", text, closed }`. A visual that hasn't closed
 * yet (a reply still streaming) runs to the end, with `closed: false`.
 */
export function splitVisuals(text) {
  const parts = [];
  const src = String(text ?? "");
  let at = 0;
  START.lastIndex = 0;
  let m;
  while ((m = START.exec(src))) {
    const begin = m.index + m[1].length;
    const lead = src.slice(begin).match(/^[ \t]*/)[0].length;
    const open = begin + lead;
    let end;
    let html;
    let closed;
    if (!m[2]) {
      // ```html fence: up to the closing fence.
      const bodyStart = src.indexOf("\n", open) + 1;
      const close = src.slice(bodyStart).search(/(^|\n)[ \t]*```[ \t]*(?=\n|$)/);
      closed = close >= 0;
      const bodyEnd = closed ? bodyStart + close : src.length;
      html = src.slice(bodyStart, bodyEnd);
      end = closed ? bodyStart + close + src.slice(bodyStart + close).match(/^\n?[ \t]*```[ \t]*/)[0].length : src.length;
    } else {
      const found = matchClose(src, open, m[2].toLowerCase());
      closed = found >= 0;
      end = closed ? found : src.length;
      html = src.slice(open, end);
    }
    if (begin > at) parts.push({ kind: "text", text: src.slice(at, begin), closed: true });
    if (html.trim()) parts.push({ kind: "visual", text: html, closed });
    at = end;
    START.lastIndex = Math.max(end, START.lastIndex);
    if (!closed) break;
  }
  if (at < src.length) parts.push({ kind: "text", text: src.slice(at), closed: true });
  return parts;
}

/** Where the element opened at `from` ends (just past its close tag), or -1. */
function matchClose(src, from, tag) {
  const re = new RegExp(`<(/?)${tag}(?=[\\s>/])[^>]*?(/?)>`, "gi");
  re.lastIndex = from;
  let depth = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m[1]) depth--;
    else if (!m[2]) depth++;
    else if (depth === 0) return re.lastIndex; // <div/> on its own
    if (depth === 0) return re.lastIndex;
  }
  return -1;
}

export function hasVisual(text) {
  return splitVisuals(text).some((p) => p.kind === "visual");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", middot: "·", times: "×", deg: "°", rarr: "→", larr: "←", bull: "•" };

/** A visual's words, in one line: what it says without how it looks. */
export function visualWords(html) {
  return String(html)
    .replace(/<(script|style|title)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?(?:div|p|li|tr|td|th|h[1-6]|br|hr|section|aside|figure|figcaption|details|summary|table|caption|ul|ol|dt|dd|header|footer|text|tspan)\b[^>]*>/gi, "\n")
    .replace(/<\/span\s*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name) => {
      if (name[0] === "#") {
        const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
      }
      return ENTITIES[name.toLowerCase()] ?? all;
    })
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" / ");
}

/**
 * The text with each visual swapped for `[visual: its words]`. With
 * `keepLast`, the last visual in the text stays as it was.
 */
export function shortenVisuals(text, { keepLast = false } = {}) {
  const parts = splitVisuals(text);
  const lastVisual = keepLast ? parts.findLastIndex((p) => p.kind === "visual") : -1;
  if (!parts.some((p) => p.kind === "visual")) return String(text ?? "");
  return parts
    .map((p, i) => {
      if (p.kind === "text" || i === lastVisual) return p.text;
      const words = visualWords(p.text);
      return words ? `[visual: ${words}]` : "[visual]";
    })
    .join("");
}

// ------------------------------------------------------------- drawing

const HTML_TAGS = new Set(
  "div span p br b strong i em u s del ins small sub sup mark abbr kbd code pre q cite blockquote h1 h2 h3 h4 h5 h6 ul ol li dl dt dd table thead tbody tfoot tr th td caption colgroup col hr details summary figure figcaption section aside header footer center font progress meter ruby rt rp wbr".split(" "),
);
const SVG_TAGS = new Set(
  "svg g rect circle ellipse line polyline polygon path text tspan defs lineargradient radialgradient stop title desc marker".split(" "),
);
/** Removed with everything inside. Other unknown tags are unwrapped: their text stays. */
const DROP = new Set(
  "script style link meta base iframe frame frameset object embed applet template noscript textarea select option input button form img image picture source video audio track canvas math foreignobject use animate animatemotion animatetransform set filter feimage pattern mask clippath".split(" "),
);
const HTML_ATTRS = new Set(["style", "title", "colspan", "rowspan", "align", "valign", "width", "height", "open", "value", "max", "min", "low", "high", "optimum", "color", "size", "dir", "lang"]);
const SVG_ATTRS = new Set(
  "style viewbox width height x y x1 y1 x2 y2 cx cy r rx ry d points fill stroke stroke-width stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-opacity fill-opacity fill-rule opacity transform font-size font-family font-weight font-style text-anchor dominant-baseline letter-spacing offset stop-color stop-opacity gradientunits gradienttransform spreadmethod fx fy preserveaspectratio dx dy rotate textlength markerwidth markerheight refx refy orient markerunits marker-start marker-mid marker-end xmlns id".split(" "),
);
/** SVG attributes that may point at a gradient or marker in the same visual: url(#id) only. */
const SVG_REFS = new Set(["fill", "stroke", "marker-start", "marker-mid", "marker-end"]);

/** A style attribute without anything that could load a file or escape the box. */
export function cleanStyle(style) {
  return String(style)
    .split(";")
    .map((d) => d.trim())
    .filter((d) => {
      const colon = d.indexOf(":");
      if (colon <= 0) return false;
      const prop = d.slice(0, colon).trim().toLowerCase();
      const value = d.slice(colon + 1).trim().toLowerCase();
      if (!/^-?[a-z][a-z-]*$/.test(prop)) return false;
      if (/url\s*\(|image-set|@import|expression|javascript:|\\|<|behavior|-moz-binding/.test(value)) return false;
      if (prop === "position" && /fixed|sticky/.test(value)) return false;
      return true;
    })
    .join(";");
}

let visualCount = 0;

/**
 * A visual as safe HTML for the chat (see the top of this file). Needs a
 * browser (DOMParser); without one, it's shown as plain words.
 */
export function sanitizeVisual(html) {
  if (typeof DOMParser === "undefined") return escapeText(visualWords(html));
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
  const prefix = `v${++visualCount}-`;
  clean(doc.body, prefix);
  return doc.body.innerHTML;
}

function clean(parent, prefix) {
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === 3) continue; // text
    if (node.nodeType !== 1) {
      node.remove(); // comments, processing instructions
      continue;
    }
    const tag = node.localName.toLowerCase();
    const inSvg = node.namespaceURI === "http://www.w3.org/2000/svg";
    if (DROP.has(tag)) {
      node.remove();
      continue;
    }
    if (!(inSvg ? SVG_TAGS : HTML_TAGS).has(tag)) {
      clean(node, prefix);
      node.replaceWith(...node.childNodes);
      continue;
    }
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      const keep = inSvg ? SVG_ATTRS.has(name) : HTML_ATTRS.has(name);
      if (!keep) {
        node.removeAttribute(attr.name);
        continue;
      }
      if (name === "style") {
        const style = cleanStyle(attr.value);
        if (style) node.setAttribute(attr.name, style);
        else node.removeAttribute(attr.name);
      } else if (name === "id") {
        // Only for gradients and markers, and never one of the app's own ids.
        if (/^(lineargradient|radialgradient|marker)$/.test(tag) && /^[\w-]+$/.test(attr.value)) node.setAttribute("id", prefix + attr.value);
        else node.removeAttribute(attr.name);
      } else if (inSvg && SVG_REFS.has(name) && /url\s*\(/i.test(attr.value)) {
        const ref = attr.value.match(/^\s*url\(\s*['"]?#([\w-]+)['"]?\s*\)\s*$/i);
        if (ref) node.setAttribute(attr.name, `url(#${prefix}${ref[1]})`);
        else node.removeAttribute(attr.name);
      } else if (/javascript:|url\s*\(|\\/i.test(attr.value)) {
        node.removeAttribute(attr.name);
      }
    }
    clean(node, prefix);
  }
}

function escapeText(text) {
  return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
