import test from "node:test";
import assert from "node:assert/strict";
import { clampWidth, DOCK_MIN, DOCK_MAX_FRACTION } from "../components/files/useDockWidth";

/* Why: the width is persisted, and the window it was chosen in may be gone. A
   stored 900px reopened on a 1024px laptop would leave ~120px for the
   conversation the dock is meant to sit beside — and the only control that
   could fix it is the handle now pushed off-screen. The clamp is what makes the
   preference safe to remember at all. */
test("a width is clamped into the window it is being shown in", () => {
  assert.equal(clampWidth(900, 1024), Math.round(1024 * DOCK_MAX_FRACTION));
  assert.equal(clampWidth(400, 1600), 400, "a width that fits is left alone");
  assert.equal(clampWidth(40, 1600), DOCK_MIN, "and one too narrow to use is widened");
});

/* Why: on a phone-width window the cap and the floor cross over. Whichever way
   that resolves it must not produce a negative or zero width, which would make
   the panel vanish with no way to bring it back. */
test("an impossibly narrow window still yields a usable panel", () => {
  for (const viewport of [0, 120, 320, DOCK_MIN]) {
    assert.equal(clampWidth(500, viewport), DOCK_MIN, `viewport ${viewport}`);
  }
});

test("a garbage width resolves to something sane rather than NaN", () => {
  assert.equal(clampWidth(Number.NaN, 1600), DOCK_MIN);
  assert.equal(clampWidth(-1, 1600), DOCK_MIN);
  assert.equal(clampWidth(Number.POSITIVE_INFINITY, 1600), Math.round(1600 * DOCK_MAX_FRACTION));
});
