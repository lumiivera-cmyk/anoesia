() => {
  const W = innerWidth, H = innerHeight, root = document.body;
  const out = { trunc: [], spill: [], offboard: [], small: [], clip384: [] };
  const seen = new Set();
  const push = (k, s) => { const key = k + s; if (!seen.has(key)) { seen.add(key); out[k].push(s); } };
  const desc = (el) => {
    const t = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 48);
    return el.tagName.toLowerCase() + (t ? ' "' + t + '"' : '');
  };
  const shown = (el) => {
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const inScroller = (el) => { for (let a = el.parentElement; a && a !== root; a = a.parentElement) { const o = getComputedStyle(a).overflowY; if (o === 'auto' || o === 'scroll') return true; } return false; };
  const clippedByScroller = (el, r) => { for (let a = el.parentElement; a && a !== root; a = a.parentElement) { const o = getComputedStyle(a).overflowY; if (o === 'auto' || o === 'scroll') { const s = a.getBoundingClientRect(); return r.top < s.top - 0.5 || r.bottom > s.bottom + 0.5; } } return false; };
  const INTER = 'button, a[href], input, textarea, [role=switch], [role=tab], [role=menuitem], [tabindex="0"]';
  for (const el of root.querySelectorAll('*')) {
    if (!shown(el) || el.classList.contains('sr') || el.closest('.sr')) continue;
    const cs = getComputedStyle(el);
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (ownText && el.scrollWidth > el.clientWidth + 1 && (cs.overflowX === 'hidden' || cs.overflowX === 'clip'))
      push('trunc', desc(el) + ' (' + el.scrollWidth + ' > ' + el.clientWidth + 'px)');
    if (el.style.height && cs.overflowY === 'visible' && el.scrollHeight > el.clientHeight + 2 && (el.innerText || '').trim())
      push('spill', desc(el) + ' (' + el.scrollHeight + ' > ' + el.clientHeight + 'px)');
    const r = el.getBoundingClientRect();
    const inter = el.matches(INTER);
    if ((inter || ownText) && !inScroller(el) && (r.right > W + 0.5 || r.bottom > H + 0.5 || r.left < -0.5 || r.top < -0.5))
      push('offboard', desc(el) + ' [' + [r.left, r.top, r.right, r.bottom].map(Math.round).join(',') + ']');
    // touch size by actual hit-testing: walk out from the centre until a tap would land on something else.
    // Counts ::after hit areas, .hit spans and wrapping labels; respects clipping and anything drawn on top.
    let hw = r.width, hh = r.height;
    if (inter && W < 500 && clippedByScroller(el, r)) {
      hw = hh = 99; // clipped by a scrollport: defer sizing until the target is fully in view
    } else if (inter && W < 500) {
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const own = (x, y) => { const e = document.elementFromPoint(x, y);
        return !!e && (e === el || el.contains(e) || (e.tagName === 'LABEL' && (e.contains(el) || e.control === el))); };
      if (own(cx, cy)) {
        const reach = (dx, dy) => { let n = 0; while (n < 40 && own(cx + dx * (n + 1), cy + dy * (n + 1))) n++; return n; };
        hw = reach(-1, 0) + reach(1, 0) + 1; hh = reach(0, -1) + reach(0, 1) + 1;
      } else { hw = hh = 99; }          // centre covered (a sheet or menu is open over it): not reachable, so not judged here
    }
    if (inter && W < 500 && (hw < 43.5 || hh < 43.5))
      push('small', desc(el) + ' ' + Math.round(hw) + '×' + Math.round(hh));
    if ((inter || ownText) && W < 500 && r.right > 384.5 && r.left < W && !inScroller(el))
      push('clip384', desc(el));
  }
  return out;
}
