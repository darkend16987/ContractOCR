"use strict";

/**
 * Nabu PDF — codec for binary payloads on the sidecar wire (pure, no DOM).
 *
 * Split out of app.js for the same reason page-range.js was: this is logic where
 * a mistake is SILENT. Get the chunk size wrong and every request still looks
 * fine in the debugger — it just carries corrupt base64, and the failure surfaces
 * as "the PDF came back damaged" far from the cause. Being DOM-free makes it
 * testable under plain node (desktop/test/wire-codec.test.js), which the rest of
 * app.js is not (docs/REGRESSION-GUARD.md §1).
 *
 * LOAD ORDER MATTERS DIFFERENTLY HERE than in page-range.js: callers use the
 * BARE names (`pdfJsonBody(...)`, `b64ToU8(...)`) from app.js, text-edit.js and
 * compare.js — 16 call sites that predate this file. Declaring them at the top
 * level of a classic <script> puts them in the shared global scope exactly as
 * before, so moving the code changed no call site (BI-14: renaming them WOULD).
 * `window.Wire` mirrors the same functions as a checkable handle for probes.
 *
 * See BI-24 for why there is deliberately no general-purpose "encode this
 * Uint8Array to base64" helper anywhere in the renderer.
 */

// Build the JSON request body for a sidecar call that carries the whole PDF,
// WITHOUT ever holding the payload as one JS string.
//
// There is deliberately NO "encode this Uint8Array to base64" helper any more.
// The obvious `JSON.stringify({ pdf_b64: <base64 of bytes>, ...fields })` costs
// three full-size copies on the renderer heap: the binary string built while
// encoding, the base64 it produces, and stringify's copy of that into the final
// body. On a 134 MB document that is ~500 MB of transient strings on top of
// state.bytes and the undo history — the same heap exhaustion v0.2.40 fixed for
// the DOWNLOAD direction and left standing here. Keeping a general-purpose
// encoder around is what let that pattern get written in the first place, so the
// streaming builders below are the only way to put binary on the wire.
//
// A Blob assembled from pieces keeps its bytes in Blink's blob store (spillable to
// disk), not on the JS heap, so only one 48 KB chunk is ever live as a string. The
// wire format is unchanged — the sidecar still receives ordinary JSON — so this is
// purely a renderer-side memory fix with no API surface to keep in step.
//
// The chunk size MUST stay a multiple of 3: base64 only pads at the end of a
// stream, so chunking on a 3-byte boundary lets the pieces be concatenated
// verbatim. (49152 is also under the ~65535 argument ceiling of Function.apply.)
//
// `bins` is either a Uint8Array (sent as "pdf_b64") or an object of
// field-name → Uint8Array, for the compare endpoints that carry two documents at
// once — the heaviest call in the app, and the one that most needs this.
// Chunk size for streaming base64 into Blob pieces. MUST stay a multiple of 3 —
// see the note above. (Also under the ~65535 argument ceiling of Function.apply.)
const B64_CHUNK = 49152;

// Append `u8` to `parts` as base64 text, in chunks, so the full encoding never
// exists as one JS string. Shared by every streaming body builder below — the
// 3-byte rule lives in exactly one place on purpose.
function pushB64Chunks(parts, u8) {
  for (let i = 0; i < u8.length; i += B64_CHUNK) {
    parts.push(btoa(String.fromCharCode.apply(null, u8.subarray(i, i + B64_CHUNK))));
  }
}

function pdfJsonBody(bins, fields) {
  const map = bins instanceof Uint8Array ? { pdf_b64: bins } : bins || {};
  const parts = ["{"];
  let first = true;
  for (const name of Object.keys(map)) {
    const u8 = map[name];
    if (!u8) continue;
    parts.push((first ? "" : ",") + JSON.stringify(name) + ':"');
    first = false;
    pushB64Chunks(parts, u8);
    parts.push('"');
  }
  for (const k of Object.keys(fields || {})) {
    const v = fields[k];
    if (v === undefined) continue;
    parts.push((first ? "" : ",") + JSON.stringify(k) + ":" + JSON.stringify(v));
    first = false;
  }
  parts.push("}");
  return new Blob(parts, { type: "application/json" });
}
// Same trick as pdfJsonBody, but for an ARRAY of binaries in one field:
// {"images":["<b64>","<b64>",…], …fields}. pdfJsonBody can't express this — it
// maps one field to one blob — and "Ảnh → PDF" is precisely the call that needs
// it: a phone-photo batch is easily 100 files × 5 MB, and JSON.stringify of that
// array is one ~670 MB JS string on top of the per-image base64 already held.
function binArrayJsonBody(field, list, fields) {
  const parts = ["{" + JSON.stringify(field) + ":["];
  (list || []).forEach((u8, idx) => {
    if (idx) parts.push(",");
    parts.push('"');
    pushB64Chunks(parts, u8);
    parts.push('"');
  });
  parts.push("]");
  for (const k of Object.keys(fields || {})) {
    const v = fields[k];
    if (v === undefined) continue;
    parts.push("," + JSON.stringify(k) + ":" + JSON.stringify(v));
  }
  parts.push("}");
  return new Blob(parts, { type: "application/json" });
}
// The decode direction: base64 PDF payload → bytes, with a plain indexed
// loop. Do NOT use Uint8Array.from(atob(b64), c => c.charCodeAt(0)) — its
// iterator+callback path allocates ~one temp object per byte and blows the V8
// heap on large (100 MB+) documents, which made an edit's re-render fail and
// leave the page blank. This loop allocates only the binary string + the output
// array. Shared with the sibling classic scripts (text-edit.js / compare.js).
function b64ToU8(b64) {
  const bin = atob(b64 || "");
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// node (tests) takes the module export; the browser already has the bare names
// above in the shared script scope. window.Wire is the same set under a name a
// probe can assert on.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { B64_CHUNK, pushB64Chunks, pdfJsonBody, binArrayJsonBody, b64ToU8 };
}
if (typeof window !== "undefined") {
  window.Wire = { B64_CHUNK, pushB64Chunks, pdfJsonBody, binArrayJsonBody, b64ToU8 };
}
