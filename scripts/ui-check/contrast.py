"""Measured contrast (from the design handoff): each text run against the real pixels behind it, with all
text made transparent. Light text is judged against the brightest 10% of its background, dark text against
the darkest 10%. WCAG AA: 4.5, or 3 for large text. usage: python3 contrast.py <results.json from hunt.cjs>"""
import json, sys, numpy as np
from PIL import Image
def lum(c):
    c = np.asarray(c, float) / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * c[..., 0] + 0.7152 * c[..., 1] + 0.0722 * c[..., 2]
import os
R = json.load(open(sys.argv[1])); OUT = os.path.dirname(os.path.abspath(sys.argv[1]))
import re
for key, r in R.items():
    slug = re.sub(r'\W+', '-', key)
    A = np.asarray(Image.open(f'{OUT}/{slug}-B.png').convert('RGB')).astype(float)
    H, W = A.shape[:2]; bad = []
    for t in r['texts']:
        x0, y0 = max(0, int(t['x'])), max(0, int(t['y'])); x1, y1 = min(W, int(t['x'] + t['w'] + 1)), min(H, int(t['y'] + t['h'] + 1))
        if x1 - x0 < 2 or y1 - y0 < 2: continue
        patch = A[y0:y1, x0:x1].reshape(-1, 3); L = lum(patch); tc = np.array(t['c'], float)
        light = lum(tc) > float(np.median(L)); q = np.percentile(L, 90 if light else 10)
        bgc = patch[np.argmin(np.abs(L - q))]; fg = tc * t['a'] + bgc * (1 - t['a'])
        l1, l2 = float(lum(fg)), float(lum(bgc)); ratio = (max(l1, l2) + .05) / (min(l1, l2) + .05)
        need = 3.0 if (t['fs'] >= 24 or (t['fs'] >= 18.66 and t['fw'] >= 700)) else 4.5
        if ratio < need: bad.append(f"{t['t']!r} {ratio:.2f}<{need} fg {'#%02x%02x%02x' % tuple(int(v) for v in fg)} bg {'#%02x%02x%02x' % tuple(int(v) for v in bgc)} at {int(t['x'])},{int(t['y'])}")
    print(f"{key}: {len(r['texts'])} text runs, {len(bad)} below AA"); [print('   ', b) for b in bad[:12]]
