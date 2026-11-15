# UI check

The design handoff's bug hunt, run against the real app instead of the
design boards. For each screen, at desktop (1440×900) and phone (390×844)
sizes, it records:

- page errors and console errors;
- an axe accessibility scan (of the open dialog, when one is open);
- the handoff's layout scan (`layout-scan.js`): cut-off text, spill,
  anything off the screen, touch targets under 44×44 on a phone (by hit
  testing), and what a 384 px phone would clip;
- a click on every visible control from a fresh load, flagging any that
  change nothing or can't be clicked;
- two screenshots per screen for the measured contrast check.

`dev.ts` starts the app on port 4950 with a throwaway data folder, seeded
from `test/fixtures/sample-cards.md`, and a stand-in for nanoGPT, so
nothing real is used or changed. Stop anything else on 4950 first.

It needs Node with Playwright and Chromium, Bun, axe-core
(`npm pack axe-core && tar xzf axe-core-*.tgz -C /tmp/axe`), and Python 3
with NumPy and Pillow.

```sh
node scripts/ui-check/hunt.cjs                 # every screen
node scripts/ui-check/hunt.cjs "phone prompts" # screens whose name contains this
NOCLICK=1 node scripts/ui-check/hunt.cjs       # skip the (slow) click test
python3 scripts/ui-check/contrast.py /tmp/anoesia-ui-check/results.json
```

Results go to `/tmp/anoesia-ui-check` (or `$OUT`). Expected findings that
aren't bugs: long names and message snippets cut off with an ellipsis,
disabled controls (they don't click and are exempt from contrast), the
current chat's row (already open), and the screen-reader-only chat title on
a phone.
