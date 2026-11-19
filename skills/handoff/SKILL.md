---
name: handoff
description: Turn a Figma frame into accessible, design-token-correct code, and prove it matches. Use when the user shares a Figma link or frame and asks to build, implement, or code it, or asks whether existing code matches a design.
---

# Handoff: Figma to code, with proof

You are implementing a Figma design. Most design-to-code output looks right and is wrong in the details: hardcoded colours one shade off the token, 14px where the scale says 16, a `div` with an `onclick` instead of a button. This skill closes that gap in four steps. Do not skip a step, and do not report the work as done until step 4 passes.

The `handoff` CLI ships with this skill. Run it with `npx -y github:mrunaliyadavps/handoff` (or `node bin/handoff.mjs` from a clone of the repo). It needs Node 20+ and Playwright's Chromium (`npx playwright install chromium`).

## 1. Get the design

Pick the first route that works.

**A. Figma REST API** (the user has `FIGMA_TOKEN` set):
```
npx -y github:mrunaliyadavps/handoff pull "<figma frame url>" --out .handoff --scale 2
```
This saves `design.json`, `variables.json` (needs a plan with Variables API access) and `reference.png`.

**B. Figma MCP server** (no token, the Figma MCP tools are available):
1. `get_screenshot` for the frame, download it to `.handoff/reference.png`. Note the scale you used.
2. `get_variable_defs` for the frame, save the returned object as `.handoff/variables.json`.
3. Run `extract-figma.js` (next to this file) through `use_figma`, with `NODE_ID` replaced by the frame id. Save the returned JSON as `.handoff/design.json`. The script is read-only.

**C. Neither:** ask the user for the frame exported as PNG and their tokens file. Without `design.json`, skip step 2 and say so.

## 2. Lint the design before writing code

```
npx -y github:mrunaliyadavps/handoff lint .handoff/design.json --tokens .handoff/variables.json --format md
```

This finds where the frame breaks its own system: colours outside the palette, colours that match a token but aren't linked to it, spacing off the scale, radii and font sizes outside their scales, text below WCAG AA contrast, touch targets under 24px (error) or 44px (warning), component sets with no focus or disabled state, and frames positioned by hand.

**Show the errors to the user and ask how to resolve them before coding.** For each one, the choice is: fix it in Figma, or follow the token the linter suggests. Never copy an off-palette colour or a failing contrast into code without the user saying so. Warnings you may resolve yourself by snapping to the suggested token, and list what you snapped.

## 3. Build with tokens only

```
npx -y github:mrunaliyadavps/handoff tokens .handoff/variables.json > tokens.css
```

Rules while writing the code:
- Every colour, spacing, radius and font size comes from a token (`var(--space-4)`, the Tailwind theme, or the project's existing token file). No raw hex or px values for these, ever. If the project already has tokens, map to those instead of generating new ones.
- Use the project's existing components first. Check the codebase before writing a new one.
- Anything clickable is a `<button>` or `<a href>`. Never put `onclick` on a `div` or `span`.
- Icon-only buttons get an `aria-label`. Groups of choices get a role and a name (`role="radiogroup"`, `aria-label`).
- Interactive elements are at least 44×44px. The visible shape can be smaller if the hit area is not.
- Build the focus and disabled states even if the frame doesn't show them, and say you did.
- Use flex or grid that mirrors the auto layout, not absolute positions.

## 4. Verify, and loop until it passes

Serve or open the page at the frame's size, then:
```
npx -y github:mrunaliyadavps/handoff verify <url-or-file> --ref .handoff/reference.png --scale 2 --tokens .handoff/variables.json --format md
```

It checks four things and writes `.handoff/report.md` and `.handoff/diff.png`:
1. **Visual match:** share of pixels that differ from the Figma frame (default limit 2%).
2. **Accessibility:** axe-core at WCAG 2.2 AA, plus clickable elements a keyboard can't reach.
3. **Tokens only:** every rendered colour, spacing, radius and font size, read from computed styles, so it works for any framework.
4. **Target sizes:** interactive elements under 44px.

Fix what it reports and run it again. If a difference is intentional (real data instead of placeholder text, a state the frame didn't show), explain it rather than forcing the pixels. When it passes, show the user the final table from `report.md`.

## What to tell the user at the end

- The lint findings and what was decided for each.
- Anything you snapped to a token, and anything you added that the design didn't show (states, labels).
- The final verify table. If something is still failing, say so plainly; don't call it done.
