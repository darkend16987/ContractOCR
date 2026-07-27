"use strict";

// Regression net for the sidecar wire codec (renderer/wire.js) — the streaming
// base64 builders behind every request that carries a PDF, plus the decode side.
//
// Why this file exists: BI-24's rules fail SILENTLY. A chunk size that isn't a
// multiple of 3 still produces a well-formed JSON body of well-formed base64 —
// it just decodes to the wrong bytes, and the user sees "the PDF came back
// damaged" with nothing pointing back here. So the grid's core job is to pin the
// wire format byte-for-byte against the obvious `JSON.stringify` form these
// builders replaced, at every chunk boundary.
//
// Run:  node desktop/test/wire-codec.test.js      (or: npm run test:wire)

const W = require("../renderer/wire.js");

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL ${name}\n  expected ${b}\n  actual   ${a}`);
  }
}

// Deterministic pseudo-random bytes: real PDFs are not runs of one value, and a
// uniform buffer would hide a chunk-boundary bug (every chunk encodes alike).
function bytes(n, seed = 1) {
  const u8 = new Uint8Array(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    u8[i] = x >>> 24;
  }
  return u8;
}

// The one-JS-string form these builders exist to avoid — used ONLY here, as the
// reference the streaming output must match exactly.
function refB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

const body = (blob) => blob.text().then(JSON.parse);

async function main() {
  const C = W.B64_CHUNK;

  // ---- the rule that breaks things silently ------------------------------

  check("chunk size is a multiple of 3 (BI-24)", C % 3, 0);
  check("chunk size is under the Function.apply ceiling", C < 65535, true);
  check("chunk size is positive", C > 0, true);

  // Canary: prove the 3-byte rule is load-bearing, so nobody "simplifies" it
  // away after reading only the assertion above. Same builder, chunk 4096 (not
  // a multiple of 3) → base64 pads mid-stream and the pieces stop concatenating.
  const canarySrc = bytes(10000, 7);
  let canary = "";
  for (let i = 0; i < canarySrc.length; i += 4096) {
    canary += refB64(canarySrc.subarray(i, i + 4096));
  }
  check("canary: chunking on a non-multiple of 3 really does corrupt", canary === refB64(canarySrc), false);

  // ---- pdfJsonBody: wire format identical to JSON.stringify --------------

  // Boundaries are where a chunking bug lives: empty, the sub-3 remainders, and
  // one byte either side of a chunk edge.
  for (const n of [0, 1, 2, 3, 4, C - 1, C, C + 1, C + 2, C + 3, 2 * C, 2 * C + 1]) {
    const u8 = bytes(n, n + 11);
    const blob = W.pdfJsonBody(u8, { dpi: 200 });
    const text = await blob.text();
    check(`pdfJsonBody ${n} B — wire format unchanged`, text, JSON.stringify({ pdf_b64: refB64(u8), dpi: 200 }));
    const back = W.b64ToU8(JSON.parse(text).pdf_b64);
    check(`pdfJsonBody ${n} B — round-trips to the same bytes`, [...back], [...u8]);
  }

  check("pdfJsonBody declares JSON so fetch sets the right type", W.pdfJsonBody(bytes(9), {}).type, "application/json");

  // ---- pdfJsonBody: field/binary combinations ----------------------------

  const a = bytes(7, 2);
  const b = bytes(5, 3);

  check("Uint8Array shorthand becomes pdf_b64", await body(W.pdfJsonBody(a, {})), { pdf_b64: refB64(a) });
  check("no fields at all", await body(W.pdfJsonBody(a)), { pdf_b64: refB64(a) });
  check(
    "two documents in one body (/compare)",
    await body(W.pdfJsonBody({ a_b64: a, b_b64: b }, { dpi: 120 })),
    { a_b64: refB64(a), b_b64: refB64(b), dpi: 120 }
  );
  check("undefined fields are dropped, not sent as null", await body(W.pdfJsonBody(a, { x: undefined, y: 1 })), {
    pdf_b64: refB64(a),
    y: 1,
  });
  check("null binary is skipped", await body(W.pdfJsonBody({ a_b64: a, b_b64: null }, {})), { a_b64: refB64(a) });
  // The comma bookkeeping has to survive there being no binary at all — the
  // first field must not get a leading comma.
  check("fields only, no binary", await body(W.pdfJsonBody({}, { fmt: "png", scope: "all" })), {
    fmt: "png",
    scope: "all",
  });
  check("nothing at all is still valid JSON", await body(W.pdfJsonBody({}, {})), {});
  check("false and 0 are sent, not treated as absent", await body(W.pdfJsonBody({}, { skip_first: false, n: 0 })), {
    skip_first: false,
    n: 0,
  });
  check(
    "strings needing escapes go through JSON.stringify",
    await body(W.pdfJsonBody({}, { name: 'a"b\\c\nđ' })),
    { name: 'a"b\\c\nđ' }
  );

  // ---- binArrayJsonBody (Ảnh → PDF) --------------------------------------

  check("empty list → empty array, still valid", await body(W.binArrayJsonBody("images", [], { page_size: "A4" })), {
    images: [],
    page_size: "A4",
  });
  check("missing list is treated as empty", await body(W.binArrayJsonBody("images", null, {})), { images: [] });
  check("single image", await body(W.binArrayJsonBody("images", [a], {})), { images: [refB64(a)] });
  check("order is preserved", await body(W.binArrayJsonBody("images", [a, b], { page_size: "fit" })), {
    images: [refB64(a), refB64(b)],
    page_size: "fit",
  });
  check("undefined fields dropped here too", await body(W.binArrayJsonBody("images", [a], { z: undefined })), {
    images: [refB64(a)],
  });
  // An image bigger than one chunk exercises the same 3-byte rule through the
  // array path, which builds its own quoting.
  const big = bytes(C + 5, 4);
  check("image larger than one chunk", await body(W.binArrayJsonBody("images", [big], {})), { images: [refB64(big)] });
  check("declares JSON", W.binArrayJsonBody("images", [a], {}).type, "application/json");

  // ---- b64ToU8 -----------------------------------------------------------

  check("decodes to exact bytes", [...W.b64ToU8(refB64(a))], [...a]);
  check("empty string → empty array", [...W.b64ToU8("")], []);
  check("null/undefined → empty array, no throw", [[...W.b64ToU8(null)], [...W.b64ToU8(undefined)]], [[], []]);
  check("returns a Uint8Array, not a plain array", W.b64ToU8(refB64(a)) instanceof Uint8Array, true);
  // High bytes are where a naive charCodeAt/String round-trip goes wrong.
  const high = new Uint8Array([0, 1, 127, 128, 200, 254, 255]);
  check("bytes above 0x7F survive", [...W.b64ToU8(refB64(high))], [...high]);

  // ---- exported surface ---------------------------------------------------

  // Pins that no general-purpose "encode a Uint8Array to base64" helper has crept
  // back in — that helper is the footgun BI-24 exists to remove.
  check("exports exactly the wire codec", Object.keys(W).sort(), [
    "B64_CHUNK",
    "b64ToU8",
    "binArrayJsonBody",
    "pdfJsonBody",
    "pushB64Chunks",
  ]);

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
