#!/usr/bin/env node
'use strict';

/* ============================================================================
 * test.js — standalone CoolProp/refrigerant-registry regression test for the
 * HELIX coil-design app (index.html).
 *
 * WHAT THIS DOES
 * ---------------
 * index.html is a single-file browser app whose refrigerant thermodynamic
 * properties come from CoolProp compiled to WebAssembly (coolprop.js +
 * coolprop.wasm, an Emscripten ES module exporting `export default Module`).
 * The app supports 10 refrigerants through a `REFRIGERANTS` registry and a
 * set of global functions (initCoolPropEngine, setRefrigerant, refSat,
 * poolBoilHo, fluxLimits, readInputs, compute, ...) that all the app's
 * calculators call into.
 *
 * This script, without touching a browser or any npm package:
 *   1. Reads index.html and extracts the app's main inline <script> block
 *      (the first inline, non-`src=` block — everything else is either a
 *      CDN <script src=...> tag or the small ES-module bootstrap loader).
 *   2. Parses the HTML form's <input>/<select> tags to recover the app's own
 *      default input values (so the app's *own* readInputs() function can be
 *      exercised unmodified).
 *   3. Evaluates that script inside a Node `vm` context stubbed with just
 *      enough fake `document`/`window`/`localStorage` DOM surface for the
 *      script to define its functions without crashing.
 *   4. Loads the real CoolProp WASM engine (via a temporary .mjs copy of
 *      coolprop.js, since this project has no package.json and therefore
 *      coolprop.js — a `.js` file — is CommonJS by default; renaming a copy
 *      to .mjs lets Node import it as the ES module it actually is).
 *   5. Wires the WASM module into the evaluated app code by calling the
 *      app's own initCoolPropEngine(), exactly like the real page does.
 *   6. For each of the app's 10 refrigerants, drives the app's own
 *      setRefrigerant() / refSat() / poolBoilHo() / fluxLimits() /
 *      readInputs() / compute() and checks the results against a small
 *      table of known-good ("golden") reference values plus basic physical
 *      sanity conditions (pressure rises with temperature, liquid denser
 *      than vapor, latent heat positive, solved outlet temperature between
 *      bath and inlet temperature, etc).
 *
 * No npm dependencies are used — only Node's built-in `vm`, `fs`, `path`,
 * and `url` modules.
 *
 * HOW TO RUN
 * ----------
 *   cd /home/user/Coil
 *   node test.js
 *
 * Must be run from /home/user/Coil (relative paths to index.html, coolprop.js
 * and coolprop.wasm all resolve against the current working directory).
 * Requires Node 22+.
 *
 * Exit code: 0 if every refrigerant passes every check, 1 otherwise (also 1
 * on any fatal setup error, e.g. missing files or a broken app script).
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const ROOT = __dirname;
const INDEX_HTML_PATH = path.join(ROOT, 'index.html');
const COOLPROP_JS_PATH = path.join(ROOT, 'coolprop.js');
const COOLPROP_WASM_PATH = path.join(ROOT, 'coolprop.wasm');
const TEMP_MJS_PATH = path.join(ROOT, 'coolprop.test.mjs');

// Refrigerants to exercise, in display order.
const REF_KEYS = [
  'R717', 'R134A', 'R22', 'R404A', 'R407C',
  'R410A', 'R507A', 'R744', 'R290', 'R1234YF',
];

// Golden reference values for refSat(0 °F) [psia, Btu/lb, lb/ft³] and the
// app's default-input full-solver outlet temperature [°F], verified against
// this exact CoolProp build.
const GOLDEN = {
  R717:    { P: 30.4,  h_fg: 568.2, rho_l: 41.33, T_out: 32.43 },
  R134A:   { P: 21.2,  h_fg: 90.9,  rho_l: 84.37, T_out: 28.45 },
  R22:     { P: 38.7,  h_fg: 93.9,  rho_l: 83.63, T_out: 25.61 },
  R404A:   { P: 48.4,  h_fg: 77.6,  rho_l: 75.80, T_out: 27.60 },
  R407C:   { P: 44.2,  h_fg: 96.7,  rho_l: 81.04, T_out: 27.19 },
  R410A:   { P: 63.1,  h_fg: 103.8, rho_l: 77.23, T_out: 26.62 },
  R507A:   { P: 49.5,  h_fg: 76.0,  rho_l: 76.27, T_out: 27.72 },
  R744:    { P: 305.7, h_fg: 119.3, rho_l: 63.76, T_out: 29.07 },
  R290:    { P: 38.4,  h_fg: 171.1, rho_l: 34.44, T_out: 31.91 },
  R1234YF: { P: 23.9,  h_fg: 74.8,  rho_l: 76.78, T_out: 28.52 },
};

const REL_TOL_PCT = 3;      // ±3% relative tolerance for golden sat-property checks
const T_OUT_TOL_F = 0.3;    // ±0.3 °F tolerance for the full-solver outlet temperature

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */

function relDiffPct(actual, expected) {
  if (expected === 0) return actual === 0 ? 0 : Infinity;
  return Math.abs(actual - expected) / Math.abs(expected) * 100;
}

/* Step 1: pull every inline <script>...</script> block out of the HTML,
 * skipping any whose opening tag carries a src= attribute (CDN scripts), and
 * return the body of the FIRST such block — the ~380 KB main app script. */
function extractMainScript(htmlNormalized) {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(htmlNormalized)) !== null) {
    const openTagAttrs = m[1];
    const body = m[2];
    if (/\bsrc\s*=/.test(openTagAttrs)) continue; // external script — skip
    return body;
  }
  throw new Error('Could not find an inline <script> block (without src=) in index.html');
}

/* Step 2: recover the HTML form's own default values so the app's own
 * readInputs() works unmodified: id -> value, for both <input> tags (id and
 * value may appear in either order) and <select> tags (the selected
 * <option>'s value, or the first option's value if none is marked selected). */
function extractDefaults(htmlNormalized) {
  const defaults = {};

  const getAttr = (attrsStr, name) => {
    const dq = attrsStr.match(new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"'));
    if (dq) return dq[1];
    const sq = attrsStr.match(new RegExp('\\b' + name + '\\s*=\\s*\'([^\']*)\''));
    return sq ? sq[1] : null;
  };

  // <input ... id="X" ... value="Y" ...> (order-independent)
  const inputRe = /<input\b([^>]*)>/g;
  let m;
  while ((m = inputRe.exec(htmlNormalized)) !== null) {
    const attrs = m[1];
    const id = getAttr(attrs, 'id');
    if (id === null) continue;
    const value = getAttr(attrs, 'value');
    defaults[id] = value !== null ? value : '';
  }

  // <select id="X">...<option value="Y" selected>...</select>
  const selectRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/g;
  while ((m = selectRe.exec(htmlNormalized)) !== null) {
    const attrs = m[1];
    const body = m[2];
    const id = getAttr(attrs, 'id');
    if (id === null) continue;

    const optionRe = /<option\b([^>]*)>/g;
    let om;
    let firstValue = null;
    let selectedValue = null;
    while ((om = optionRe.exec(body)) !== null) {
      const oattrs = om[1];
      const value = getAttr(oattrs, 'value');
      const v = value !== null ? value : '';
      if (firstValue === null) firstValue = v;
      if (selectedValue === null && /\bselected\b/.test(oattrs)) selectedValue = v;
    }
    defaults[id] = selectedValue !== null ? selectedValue : (firstValue !== null ? firstValue : '');
  }

  return defaults;
}

/* Step 3: build a vm context with permissive DOM stubs. Elements are cached
 * per id so repeated getElementById(id) calls return the same object. */
function buildVmContext(defaults) {
  const elCache = new Map();

  function makeEl(id) {
    if (elCache.has(id)) return elCache.get(id);
    const el = {
      value: defaults[id] ?? '',
      textContent: '',
      innerHTML: '',
      style: {},
      disabled: false,
      title: '',
      dataset: {},
      options: [],
      classList: {
        add() {}, remove() {}, toggle() {}, contains: () => false,
      },
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      appendChild() {},
      getAttribute: () => null,
      setAttribute() {},
      focus() {},
    };
    elCache.set(id, el);
    return el;
  }

  const context = {
    console,
    document: {
      getElementById: (id) => makeEl(id),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => makeEl('_'),
      addEventListener() {},
      documentElement: makeEl('_root'),
      title: '',
      hidden: false,
    },
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
    location: { hash: '', href: '' },
    history: { replaceState() {} },
    alert() {},
    requestAnimationFrame: (_f) => {},
    setTimeout,
    clearTimeout,
    Math,
    JSON,
    performance: (typeof performance !== 'undefined') ? performance : { now: () => Date.now() },
  };
  context.window = context; // self-reference, set BEFORE createContext

  vm.createContext(context);
  return context;
}

/* Evaluate `expr` (a JS expression string) inside the vm context and marshal
 * its value out via JSON — the vm context is a separate V8 realm, so this is
 * the safe way to bring plain-data results back into the host Node realm. */
function evalJSON(ctx, expr) {
  const raw = vm.runInContext(`JSON.stringify(${expr})`, ctx);
  return JSON.parse(raw);
}

function evalRaw(ctx, expr) {
  return vm.runInContext(expr, ctx);
}

/* ---------------------------------------------------------------------------
 * Per-refrigerant checks
 * ------------------------------------------------------------------------ */

function checkFluid(ctx, key, shortName) {
  const golden = GOLDEN[key];
  const checks = [];

  // (a) setRefrigerant(key) then confirm REF_KEY switched.
  evalRaw(ctx, `setRefrigerant(${JSON.stringify(key)});`);
  const refKeyNow = evalRaw(ctx, 'REF_KEY');
  checks.push({
    name: 'setRefrigerant/REF_KEY',
    ok: refKeyNow === key,
    msg: `REF_KEY expected '${key}' got '${refKeyNow}'`,
  });

  // (b) refSat(0): P_psia, h_fg, rho_l vs golden table, each within ±3%.
  const s0 = evalJSON(ctx, `(function(){
    const s = refSat(0);
    return { P_psia: s.P_psia, h_fg: s.h_fg, rho_l: s.rho_l, rho_g: s.rho_g, sigma_Nm: s.sigma_Nm };
  })()`);
  const dP = relDiffPct(s0.P_psia, golden.P);
  const dHfg = relDiffPct(s0.h_fg, golden.h_fg);
  const dRhoL = relDiffPct(s0.rho_l, golden.rho_l);
  const satFails = [];
  if (!(dP <= REL_TOL_PCT)) {
    satFails.push(`sat pressure @0F expected ${golden.P} got ${s0.P_psia.toFixed(1)} (Δ${dP.toFixed(1)}%)`);
  }
  if (!(dHfg <= REL_TOL_PCT)) {
    satFails.push(`sat h_fg @0F expected ${golden.h_fg} got ${s0.h_fg.toFixed(1)} (Δ${dHfg.toFixed(1)}%)`);
  }
  if (!(dRhoL <= REL_TOL_PCT)) {
    satFails.push(`sat rho_l @0F expected ${golden.rho_l} got ${s0.rho_l.toFixed(2)} (Δ${dRhoL.toFixed(1)}%)`);
  }
  checks.push({ name: 'sat@0F vs golden', ok: satFails.length === 0, msg: satFails.join('; ') });

  // (c) |refSat(-40).h_f| <= 0.3  (ASHRAE reference: h_f = 0 at -40 °F).
  const sM40 = evalJSON(ctx, `(function(){ return { h_f: refSat(-40).h_f }; })()`);
  checks.push({
    name: 'h_f@-40F≈0',
    ok: Math.abs(sM40.h_f) <= 0.3,
    msg: `|refSat(-40).h_f| expected <=0.3 got ${sM40.h_f.toFixed(3)}`,
  });

  // (d) refSat(20).P_psia > refSat(0).P_psia (saturation pressure monotonic in T).
  const s20 = evalJSON(ctx, `(function(){ return { P_psia: refSat(20).P_psia }; })()`);
  checks.push({
    name: 'P monotonic in T',
    ok: s20.P_psia > s0.P_psia,
    msg: `refSat(20).P_psia (${s20.P_psia.toFixed(2)}) not > refSat(0).P_psia (${s0.P_psia.toFixed(2)})`,
  });

  // (e) h_fg > 0, rho_l > rho_g, sigma_Nm in [0.001, 0.06].
  const sanityFails = [];
  if (!(s0.h_fg > 0)) sanityFails.push(`h_fg not > 0 (${s0.h_fg})`);
  if (!(s0.rho_l > s0.rho_g)) sanityFails.push(`rho_l (${s0.rho_l}) not > rho_g (${s0.rho_g})`);
  if (!(s0.sigma_Nm >= 0.001 && s0.sigma_Nm <= 0.06)) {
    sanityFails.push(`sigma_Nm out of [0.001,0.06]: ${s0.sigma_Nm}`);
  }
  checks.push({ name: 'sat physical sanity', ok: sanityFails.length === 0, msg: sanityFails.join('; ') });

  // (f) Full solver scenario at app default inputs.
  const sol = evalJSON(ctx, `(function(){
    PROP_WARN.clear();
    const I = readInputs();
    const R = compute(I);
    return {
      T_out: R.T_out,
      Q: R.Q, Q_finite: Number.isFinite(R.Q),
      h_o: R.h_o,
      h_i: R.h_i,
      dP_psi: R.dP_psi, dP_psi_finite: Number.isFinite(R.dP_psi),
      bath_temp: I.bath_temp,
      inlet_temp: I.inlet_temp,
    };
  })()`);
  const dT = Math.abs(sol.T_out - golden.T_out);
  const solverFails = [];
  if (!(dT <= T_OUT_TOL_F)) {
    solverFails.push(`T_out expected ${golden.T_out} got ${sol.T_out.toFixed(2)} (Δ${dT.toFixed(2)}°F)`);
  }
  if (!(sol.Q > 0 && sol.Q_finite)) solverFails.push(`Q not positive/finite (${sol.Q})`);
  if (!(sol.h_o > 0)) solverFails.push(`h_o not > 0 (${sol.h_o})`);
  if (!(sol.h_i > 0)) solverFails.push(`h_i not > 0 (${sol.h_i})`);
  if (!(sol.dP_psi > 0 && sol.dP_psi_finite)) solverFails.push(`dP_psi not positive/finite (${sol.dP_psi})`);
  if (!(sol.bath_temp < sol.T_out && sol.T_out < sol.inlet_temp)) {
    solverFails.push(`T_out (${sol.T_out}) not between bath_temp (${sol.bath_temp}) and inlet_temp (${sol.inlet_temp})`);
  }
  checks.push({ name: 'full solver scenario', ok: solverFails.length === 0, msg: solverFails.join('; ') });

  // (g) poolBoilHo(24).scale and fluxLimits(24).q_practical.
  const pool = evalJSON(ctx, `(function(){ return poolBoilHo(24); })()`);
  let poolOk, poolMsg = '';
  if (key === 'R717') {
    poolOk = Math.abs(pool.scale - 1.0) <= 1e-9;
    if (!poolOk) poolMsg = `poolBoilHo(24).scale expected 1.0 got ${pool.scale}`;
  } else {
    poolOk = pool.scale > 0;
    if (!poolOk) poolMsg = `poolBoilHo(24).scale expected > 0 got ${pool.scale}`;
  }
  checks.push({ name: 'poolBoilHo(24).scale', ok: poolOk, msg: poolMsg });

  const flux = evalJSON(ctx, `(function(){ return fluxLimits(24); })()`);
  let fluxOk, fluxMsg = '';
  if (key === 'R717') {
    fluxOk = Math.abs(flux.q_practical - 10000) <= 1;
    if (!fluxOk) fluxMsg = `fluxLimits(24).q_practical expected 10000±1 got ${flux.q_practical}`;
  } else {
    fluxOk = flux.q_practical >= 500 && flux.q_practical <= 30000;
    if (!fluxOk) fluxMsg = `fluxLimits(24).q_practical expected in [500,30000] got ${flux.q_practical}`;
  }
  checks.push({ name: 'fluxLimits(24).q_practical', ok: fluxOk, msg: fluxMsg });

  return checks;
}

function printFluidResult(shortName, checks) {
  const total = checks.length;
  const passed = checks.filter((c) => c.ok).length;
  const label = shortName.padEnd(9);
  if (passed === total) {
    console.log(`PASS  ${label}(${passed}/${total} checks)`);
  } else {
    const fails = checks
      .filter((c) => !c.ok)
      .map((c) => c.msg || c.name)
      .join('; ');
    console.log(`FAIL  ${label}(${passed}/${total}): ${fails}`);
  }
  return passed === total;
}

/* ---------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------ */

async function main() {
  if (!fs.existsSync(INDEX_HTML_PATH)) throw new Error(`Missing file: ${INDEX_HTML_PATH}`);
  if (!fs.existsSync(COOLPROP_JS_PATH)) throw new Error(`Missing file: ${COOLPROP_JS_PATH}`);
  if (!fs.existsSync(COOLPROP_WASM_PATH)) throw new Error(`Missing file: ${COOLPROP_WASM_PATH}`);

  const htmlRaw = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const html = htmlRaw.replace(/\r\n/g, '\n'); // normalize CRLF -> LF before eval

  const mainScript = extractMainScript(html);
  console.log(`[setup] extracted main app script (${mainScript.length} bytes)`);

  const defaults = extractDefaults(html);
  console.log(`[setup] parsed ${Object.keys(defaults).length} input/select defaults from index.html`);

  const ctx = buildVmContext(defaults);

  try {
    vm.runInContext(mainScript, ctx, { filename: 'index.html:main-script' });
  } catch (e) {
    // Expected: the tail of the script wires DOM events / triggers an initial
    // recompute() against our stubs and may throw. Harmless — every
    // function/const declared earlier in the script has already been
    // evaluated by the time execution reaches that point.
    console.log(`[setup] note: main script tail threw against DOM stubs (expected): ${e && e.message ? e.message : e}`);
  }

  const registryOk = evalRaw(ctx, "typeof REFRIGERANTS === 'object' && REFRIGERANTS !== null");
  if (!registryOk) {
    throw new Error(
      'REFRIGERANTS registry not found after evaluating the main app script — ' +
      'script extraction from index.html or evaluation in the vm context failed.'
    );
  }

  // Step 4: load the real CoolProp WASM engine. coolprop.js is CommonJS by
  // default here (no package.json), but it is actually an Emscripten ES
  // module (`export default Module`). Copy it to a .mjs file in the SAME
  // directory (so its internal locateFile()/import.meta.url logic still
  // finds coolprop.wasm) and import it dynamically.
  fs.copyFileSync(COOLPROP_JS_PATH, TEMP_MJS_PATH);
  let cp;
  try {
    const mod = await import(pathToFileURL(TEMP_MJS_PATH).href);
    cp = await mod.default({ locateFile: (f) => './' + f });
  } finally {
    fs.rmSync(TEMP_MJS_PATH, { force: true });
  }
  console.log('[setup] CoolProp WASM module loaded');

  // Step 5: neutralize UI lifecycle hooks before wiring the engine in, then
  // initialize exactly like the real page does.
  vm.runInContext('refreshFluidLabels = () => {}; recomputeAllTabs = () => {};', ctx);
  ctx.__cpMod = cp;
  evalRaw(ctx, 'initCoolPropEngine(__cpMod);');
  console.log('[setup] initCoolPropEngine() complete\n');

  const shortNames = evalJSON(ctx, `(function(){
    const o = {};
    for (const k of Object.keys(REFRIGERANTS)) o[k] = REFRIGERANTS[k].short;
    return o;
  })()`);

  // Step 6: per-refrigerant checks.
  let fluidsPassed = 0;
  for (const key of REF_KEYS) {
    const checks = checkFluid(ctx, key, shortNames[key] || key);
    const ok = printFluidResult(shortNames[key] || key, checks);
    if (ok) fluidsPassed++;
  }

  console.log('');
  console.log(`RESULT: ${fluidsPassed}/${REF_KEYS.length} PASS`);
  process.exitCode = fluidsPassed === REF_KEYS.length ? 0 : 1;
}

main().catch((err) => {
  console.error('\nFATAL ERROR: ' + (err && err.stack ? err.stack : String(err)));
  process.exitCode = 1;
});
