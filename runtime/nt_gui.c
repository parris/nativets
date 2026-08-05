/*
 * nt_gui.c — a MINIMAL immediate-mode GUI primitive for nativets (north-star
 * "cross-platform UI app", docs/examples.md C-d), backed by raylib.
 *
 * raylib (https://www.raylib.com) is a tiny immediate-mode graphics library that
 * targets macOS / Linux / Windows AND WebAssembly (emscripten), so it fits
 * nativets' retargetable backend: draw a display + a button grid, poll the mouse,
 * hit-test, repeat. Exposed to codegen as a handful of FLAT scalar-ABI functions
 * (every nativets number is an IEEE-754 double; booleans are i32 0/1) so no raylib
 * struct (e.g. `Color`) ever has to cross the FFI boundary — colors are passed as
 * a small PALETTE INDEX and resolved to a `Color` here.
 *
 * PORTABILITY / linking: this file is compiled + linked (with -lraylib + the
 * platform frameworks raylib needs) ONLY when a program actually calls a GUI
 * builtin — exactly like nt_http.c + libcurl. Non-GUI programs, and every
 * cross-build, stay entirely raylib-free (see driver.ts conditional link). It is
 * additive & self-contained: it includes only <raylib.h> and forward-declares
 * nothing from runtime.c (the surface here is pure raylib + arithmetic).
 *
 * The windowed run is HOST desktop today (macOS/Linux/Windows). raylib also
 * builds to wasm via emscripten + raylib-web; wiring that into the `--target wasm`
 * (wasi) lane is a documented follow-on (wasi != emscripten) — see calc-gui.ts.
 */

#include <raylib.h>

/*
 * A tiny fixed palette so codegen can pass a color as a plain number (double)
 * without marshaling raylib's `Color` struct across the FFI. Index out of range
 * clamps to 0. Tuned for a calculator: a dark shell, a display panel, gray/accent
 * buttons, and readable text.
 */
static Color nt_gui_palette(double idx) {
  int i = (int)idx;
  switch (i) {
    case 0:  return (Color){ 30, 30, 40, 255 };    /* window / shell background */
    case 1:  return (Color){ 200, 200, 210, 255 }; /* light gray               */
    case 2:  return (Color){ 245, 245, 245, 255 }; /* near-white (text)        */
    case 3:  return (Color){ 255, 150, 40, 255 };  /* accent (operators / =)   */
    case 4:  return (Color){ 60, 60, 72, 255 };    /* button face              */
    case 5:  return (Color){ 20, 20, 28, 255 };    /* display panel background */
    case 6:  return (Color){ 0, 0, 0, 255 };       /* black                    */
    case 7:  return (Color){ 90, 90, 105, 255 };   /* button face (hover/alt)  */
    case 8:  return (Color){ 200, 60, 60, 255 };   /* clear (C)                */
    default: return (Color){ 30, 30, 40, 255 };
  }
}

/* --- window lifecycle ---------------------------------------------------- */

void nt_gui_init_window(double w, double h, const char *title) {
  InitWindow((int)w, (int)h, title ? title : "nativets");
}

/* i32 boolean: 1 when the user closed the window (or pressed ESC). */
int nt_gui_window_should_close(void) {
  return WindowShouldClose() ? 1 : 0;
}

void nt_gui_set_target_fps(double n) {
  SetTargetFPS((int)n);
}

/* --- per-frame drawing --------------------------------------------------- */

void nt_gui_begin_draw(void) { BeginDrawing(); }
void nt_gui_end_draw(void)   { EndDrawing(); }

void nt_gui_clear_background(double color) {
  ClearBackground(nt_gui_palette(color));
}

void nt_gui_draw_text(const char *s, double x, double y, double size, double color) {
  DrawText(s ? s : "", (int)x, (int)y, (int)size, nt_gui_palette(color));
}

void nt_gui_draw_rect(double x, double y, double w, double h, double color) {
  DrawRectangle((int)x, (int)y, (int)w, (int)h, nt_gui_palette(color));
}

/* --- input --------------------------------------------------------------- */

double nt_gui_mouse_x(void) { return (double)GetMouseX(); }
double nt_gui_mouse_y(void) { return (double)GetMouseY(); }

/* i32 boolean: 1 on the frame the left mouse button transitions to pressed. */
int nt_gui_mouse_pressed(void) {
  return IsMouseButtonPressed(MOUSE_BUTTON_LEFT) ? 1 : 0;
}

/*
 * Pure geometry (no raylib call): 1 when (px,py) is inside the [x,x+w) x [y,y+h)
 * rectangle. Exposed as a builtin for hit-testing convenience; the example's own
 * hit-test is written in plain TS so its unit tests need no raylib.
 */
int nt_gui_point_in_rect(double px, double py, double x, double y, double w, double h) {
  return (px >= x && px < x + w && py >= y && py < y + h) ? 1 : 0;
}
