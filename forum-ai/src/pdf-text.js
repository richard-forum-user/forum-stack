function latin1(bytes) {
  let out = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return out;
}

function unescapePdf(value) {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== "\\") {
      out += value[i];
      continue;
    }
    const next = value[i + 1];
    if (next === undefined) break;
    i += 1;
    if (next >= "0" && next <= "7") {
      let oct = next;
      for (let k = 0; k < 2 && value[i + 1] >= "0" && value[i + 1] <= "7"; k += 1) {
        i += 1;
        oct += value[i];
      }
      out += String.fromCharCode(Number.parseInt(oct, 8));
    } else if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else out += next;
  }
  return out;
}

function fromTjArray(segment) {
  let out = "";
  const re = /\(((?:\\.|[^\\)])*)\)|(-?\d+(?:\.\d+)?)/g;
  let match;
  while ((match = re.exec(segment))) {
    if (match[1] !== undefined) out += unescapePdf(match[1]);
    else if (Math.abs(Number(match[2])) >= 80) out += " ";
  }
  return out;
}

export function textFromContent(body) {
  const bits = [];
  const re = /\[((?:\\.|[^\]\\])*)\]\s*TJ|\(((?:\\.|[^\\)])*)\)\s*Tj/g;
  let match;
  while ((match = re.exec(body))) {
    const piece = match[1] !== undefined ? fromTjArray(match[1]) : unescapePdf(match[2]);
    if (piece) bits.push(piece);
  }
  return bits.join(" ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").replace(/\s+/g, " ").trim();
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function findMarker(source, marker, from) {
  return source.indexOf(marker, from);
}

// Reads the text operators out of a PDF. Bill text from the legislature is a PDF.
export async function pdfToText(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const source = latin1(bytes);
  const chunks = [];
  let cursor = 0;
  while (cursor < source.length) {
    const at = findMarker(source, "stream", cursor);
    if (at < 0) break;
    const dict = source.slice(Math.max(0, at - 500), at);
    let start = at + "stream".length;
    if (source[start] === "\r") start += 1;
    if (source[start] === "\n") start += 1;
    const end = findMarker(source, "endstream", start);
    if (end < 0) break;
    let raw = bytes.subarray(start, end);
    if (dict.includes("/FlateDecode")) {
      while (raw.length && (raw[raw.length - 1] === 0x0a || raw[raw.length - 1] === 0x0d || raw[raw.length - 1] === 0x20)) {
        raw = raw.subarray(0, raw.length - 1);
      }
      try {
        raw = await inflate(raw);
      } catch {
        cursor = end + "endstream".length;
        continue;
      }
    }
    const body = latin1(raw);
    if (body.includes("BT") && (body.includes("Tj") || body.includes("TJ"))) {
      const text = textFromContent(body);
      if (text) chunks.push(text);
    }
    cursor = end + "endstream".length;
  }
  return chunks.join(" ").replace(/\s+/g, " ").trim();
}
