// Call orders of the node:zlib zstd decoder. One line of JSON for each.
// Run on a reference Node and on a build, then diff the two outputs.
// With --experimental-stream-iter it also covers node:zlib/iter.
const zlib = require("node:zlib");
const util = require("node:util");
const { ZSTD_e_continue, ZSTD_e_flush, ZSTD_e_end } = zlib.constants;

const payload = Buffer.alloc(6000, "hello world ");
const frame = zlib.zstdCompressSync(payload);
const truncated = frame.subarray(0, frame.length - 10);
const first = zlib.zstdCompressSync(Buffer.from("first\n"));
const second = zlib.zstdCompressSync(Buffer.from("second\n"));
const junk = Buffer.from("not valid compressed data");
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const skMagic = Buffer.from([0x50, 0x2a, 0x4d, 0x18]);
const skippable = n => Buffer.from([n, 0x2a, 0x4d, 0x18, 4, 0, 0, 0, 1, 2, 3, 4]);
const exact = zlib.zstdCompressSync(Buffer.alloc(16384, "a"));
const big = Buffer.alloc(1 << 20, "hello world ");
const bigFrame = zlib.zstdCompressSync(big);
const bytewise = b => Array.from(b, x => Buffer.of(x));
const repeat = (n, op) => Array.from({ length: n }, () => op);

const err = e => [e?.constructor?.name, e?.message, e?.code, e?.errno, e ? Object.keys(e).sort().join("+") : ""].join("|");
const rows = [];
const rec = (k, v) => rows.push(k.padEnd(64) + JSON.stringify(v));

function sync(buf, opts) {
  try {
    return { ok: zlib.zstdDecompressSync(buf, opts).length };
  } catch (e) {
    return { error: err(e) };
  }
}
const cb = (buf, opts) =>
  new Promise(resolve => {
    const done = (e, r) => resolve(e ? { error: err(e) } : { ok: r.length });
    if (opts) zlib.zstdDecompress(buf, opts, done);
    else zlib.zstdDecompress(buf, done);
  });

// An operation is a chunk to write, or a function that gets the stream.
async function run(operations, options) {
  const decoder = zlib.createZstdDecompress(options);
  const result = { output: 0, stopped: "close", bytesWritten: 0 };
  const closed = new Promise(resolve => decoder.on("close", resolve));
  decoder.on("data", chunk => (result.output += chunk.length));
  decoder.on("end", () => (result.stopped = "end"));
  decoder.on("error", e => (result.stopped = err(e)));
  for (const operation of operations) {
    if (typeof operation === "function") await operation(decoder);
    else decoder.write(operation);
  }
  // A runtime that never closes the stream for this order: settle when idle.
  await Promise.race([closed, new Promise(r => setTimeout(r, 30000)).then(() => (result.stopped += " (never closed)"))]);
  result.bytesWritten = decoder.bytesWritten;
  return result;
}
const end = d => d.end();
const flushEnd = d => d.flush(ZSTD_e_end);
const written = chunk => d => new Promise(resolve => d.write(chunk, resolve));

function processChunks(steps) {
  const s = new zlib.ZstdDecompress();
  s.on("error", () => {});
  const h = s._handle;
  const close = h.close;
  h.close = () => {};
  let output = 0;
  try {
    for (const [chunk, flush] of steps) {
      output += s._processChunk(chunk, flush).length;
      s._handle = h;
    }
    return { ok: output };
  } catch (e) {
    return { error: err(e), output };
  } finally {
    try {
      close.call(h);
    } catch {}
  }
}

(async () => {
  // 1. input after a complete frame
  rec("after: write(frame),write(junk),write(frame),end", await run([first, junk, second, end]));
  rec("after: write(frame),write(junk) with no end", await run([first, junk]));
  rec("after: write(frame),end(junk)", await run([first, d => d.end(junk)]));
  rec("after: write(frame+junk),end", await run([Buffer.concat([first, junk]), end]));
  rec("after: sync 16384-byte frame + junkjunk", sync(Buffer.concat([exact, Buffer.from("junkjunk")])));
  rec("after: sync frame+frame", sync(Buffer.concat([first, second])));
  rec("after: stream bytewise(frame+frame),end", await run([...bytewise(Buffer.concat([first, second])), end]));
  rec("after: frame+2 bytes of next, rest, end", await run([Buffer.concat([first, second.subarray(0, 2)]), second.subarray(2), end]));
  rec("after: frame, first 20 of big, rest, end", await run([first, bigFrame.subarray(0, 20), bigFrame.subarray(20), end]));
  for (const n of [0x50, 0x5a, 0x5f, 0x60]) {
    rec(`after: sync frame + skippable(0x${n.toString(16)}) + frame`, sync(Buffer.concat([first, skippable(n), second])));
    rec(`after: stream frame, skippable(0x${n.toString(16)}), frame, end`, await run([first, skippable(n), second, end]));
  }
  rec("after: sync skippable alone", sync(skippable(0x50)));
  rec("after: sync 1 MiB frame, chunkSize 64", sync(bigFrame, { chunkSize: 64 }));
  rec("after: stream 1 MiB frame, chunkSize 64", await run([bigFrame, end], { chunkSize: 64 }));
  rec("after: sync junk alone", sync(junk));
  rec("after: stream write(junk),end", await run([junk, end]));

  // 2. input that ends inside a frame
  const inputs = {
    empty: Buffer.alloc(0),
    truncated,
    "frame+truncated": Buffer.concat([frame, truncated]),
    "frame+magic4": Buffer.concat([frame, magic]),
    "magic2-alone": magic.subarray(0, 2),
    "skippable-cut2": skippable(0x50).subarray(0, 10),
  };
  for (const [name, buf] of Object.entries(inputs)) {
    rec(`ends: sync ${name}`, sync(buf));
    rec(`ends: callback ${name}`, await cb(buf));
    rec(`ends: promisify ${name}`, await util.promisify(zlib.zstdDecompress)(buf).then(r => ({ ok: r.length }), e => ({ error: err(e) })));
    rec(`ends: stream end(chunk) ${name}`, await run([d => d.end(buf)]));
  }
  rec("ends: written(truncated), end", await run([written(truncated), end]));
  rec("ends: write(frame),write(truncated),end in one tick", await run([frame, truncated, end]));
  rec("ends: end() with no write", await run([end]));
  rec("ends: flush(e_end) before the first write, end", await run([flushEnd, end]));
  rec("ends: truncated, flush(e_end), end", await run([truncated, flushEnd, end]));
  rec("ends: options.flush = e_end, first 10 bytes, end", await run([frame.subarray(0, 10), end], { flush: ZSTD_e_end }));
  rec("ends: frame, magic[0..2], magic[2..4], end", await run([frame, magic.subarray(0, 2), magic.subarray(2), end]));
  rec("ends: bytewise(frame+truncated), end", await run([...bytewise(Buffer.concat([frame, truncated])), end]));
  rec("ends: 1 MiB cut by 10, output before the error", await run([bigFrame.subarray(0, bigFrame.length - 10), end]));
  rec("ends: written(frame), reset, end", await run([written(frame), d => d.reset(), end]));
  rec("ends: _processChunk(truncated, e_end)", processChunks([[truncated, ZSTD_e_end]]));
  rec("ends: _processChunk(truncated, e_continue),(empty, e_end)", processChunks([[truncated, ZSTD_e_continue], [Buffer.alloc(0), ZSTD_e_end]]));
  rec("ends: _processChunk(frame, e_continue),(empty, e_end)", processChunks([[frame, ZSTD_e_continue], [Buffer.alloc(0), ZSTD_e_end]]));

  // 3. input that is complete: the check must not report it
  rec("keeps: sync full", sync(frame));
  rec("keeps: sync frame+frame", sync(Buffer.concat([frame, frame])));
  rec("keeps: sync frame+junk", sync(Buffer.concat([frame, Buffer.from("not zstd at all")])));
  for (const n of [1, 2, 3]) {
    for (const [name, m] of [["magic", magic], ["skmagic", skMagic]]) {
      const input = Buffer.concat([frame, m.subarray(0, n)]);
      rec(`keeps: sync frame+${name}${n}`, { default: sync(input), chunk64: sync(input, { chunkSize: 64 }) });
      rec(`keeps: stream frame, ${name}${n} bytewise, end`, await run([frame, ...bytewise(m.subarray(0, n)), end]));
    }
  }
  for (const [name, ops] of [
    ["frame, flush(e_end), frame, end", [frame, flushEnd, frame, end]],
    ["frame, 20 flush(e_end), end", [frame, ...repeat(20, flushEnd), end]],
    ["frame, 20 empty writes, end", [frame, ...repeat(20, Buffer.alloc(0)), end]],
    ["written(truncated), reset, frame, end", [written(truncated), d => d.reset(), frame, end]],
  ]) {
    rec(`keeps: ${name}`, await run(ops));
    rec(`keeps: ${name} [chunkSize 64]`, await run(ops, { chunkSize: 64 }));
  }
  for (const [n, finishFlush] of [["e_flush", ZSTD_e_flush], ["e_continue", ZSTD_e_continue]]) {
    for (const [name, input] of [["truncated", truncated], ["empty", Buffer.alloc(0)]]) {
      rec(`optout ${n}: sync ${name}`, sync(input, { finishFlush }));
      rec(`optout ${n}: callback ${name}`, await cb(input, { finishFlush }));
      rec(`optout ${n}: stream ${name}`, await run([d => d.end(input)], { finishFlush }));
    }
  }
  rec("optout: _finishFlushFlag = e_flush, end(truncated)", await run([d => (d._finishFlushFlag = ZSTD_e_flush), d => d.end(truncated)]));
  rec("keeps: write(truncated), destroy", await run([truncated, d => d.destroy()]));
  rec("keeps: write(truncated), close", await run([truncated, d => d.close()]));

  // 4. node:zlib/iter, which has its own drivers
  let iter;
  try {
    iter = { s: require("stream/iter"), z: require("zlib/iter") };
  } catch {}
  if (iter) {
    const a = zlib.zstdCompressSync("a");
    const b = zlib.zstdCompressSync("b");
    const shape = v => v.then(o => ({ ok: Buffer.from(o).toString().slice(0, 20) }), e => ({ error: err(e) }));
    for (const [name, chunks] of Object.entries({
      "[a, junk, b]": [a, Buffer.from("junk"), b],
      "[a, junk]": [a, Buffer.from("junk")],
      "[a + junk]": [Buffer.concat([a, Buffer.from("junk")])],
      "[a, b]": [a, b],
      "[a + b]": [Buffer.concat([a, b])],
      "[truncated]": [truncated],
      "[frame, truncated]": [frame, truncated],
      "[]": [],
    })) {
      rec(`iter async ${name}`, await shape(iter.s.bytes(iter.s.pull(iter.s.from(chunks), iter.z.decompressZstd()))));
      rec(`iter sync  ${name}`, await shape((async () => iter.s.bytesSync(iter.s.pullSync(iter.s.fromSync(chunks), iter.z.decompressZstdSync())))()));
    }
  } else {
    rec("iter", "not loaded: run with --experimental-stream-iter");
  }

  console.log(rows.join("\n"));
})();
