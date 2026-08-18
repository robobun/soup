export function lines(this: ReadableStream) {
  if (!$inheritsReadableStream(this)) throw $ERR_INVALID_THIS("ReadableStream");

  // Lock the stream now, like values() and getReader() do, instead of on the
  // first next() call.
  const chunks = this.values();

  async function* ReadableStreamLines() {
    const decoder = new TextDecoder();
    // Pieces of the line in progress. Kept as an array so that a line spanning
    // many chunks is joined once instead of re-copied per chunk.
    let pending: string[] = [];

    for await (const chunk of chunks) {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });

      let newline = text.indexOf("\n");
      if (newline === -1) {
        if (text.length !== 0) pending.push(text);
        continue;
      }

      let start = 0;
      do {
        let line = text.slice(start, newline);
        if (pending.length !== 0) {
          pending.push(line);
          line = pending.join("");
          pending = [];
        }
        yield stripCarriageReturn(line);
        start = newline + 1;
        newline = text.indexOf("\n", start);
      } while (newline !== -1);

      if (start < text.length) pending.push(text.slice(start));
    }

    // A UTF-8 sequence cut off by the end of the stream becomes U+FFFD, the
    // same as text().
    const tail = decoder.decode();
    if (tail.length !== 0) pending.push(tail);
    if (pending.length !== 0) yield stripCarriageReturn(pending.join(""));
  }

  function stripCarriageReturn(line: string) {
    return line.length !== 0 && line.charCodeAt(line.length - 1) === 0x0d ? line.slice(0, -1) : line;
  }

  return ReadableStreamLines();
}
