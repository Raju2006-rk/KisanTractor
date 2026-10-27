/** Reads pixel dimensions from WebP and AVIF headers without decoding the image. */

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

function webpSize(bytes: Buffer): ImageSize {
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  }
  if (chunk === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (chunk === "VP8 ") {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  throw new Error(`unsupported WebP chunk ${chunk}`);
}

/** AVIF stores the coded size in the `ispe` (image spatial extents) property. */
function avifSize(bytes: Buffer): ImageSize {
  const marker = bytes.indexOf("ispe", 0, "ascii");
  if (marker < 0) throw new Error("AVIF without an ispe box");
  // Box type is followed by a 4-byte version/flags field, then width and height.
  return { width: bytes.readUInt32BE(marker + 8), height: bytes.readUInt32BE(marker + 12) };
}

export function imageSize(bytes: Buffer): ImageSize {
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return webpSize(bytes);
  if (bytes.toString("ascii", 4, 8) === "ftyp" && /avi[fs]/.test(bytes.toString("ascii", 8, 32))) return avifSize(bytes);
  throw new Error("unrecognized image format");
}
