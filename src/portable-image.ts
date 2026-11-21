import { MemorySource, type ImageLimits } from "purejsimage";
import { jpegCodec } from "purejsimage/codecs/jpeg";
import { pngCodec } from "purejsimage/codecs/png";
import { webpCodec } from "purejsimage/codecs/webp";

const codecs = {
  "image/jpeg": jpegCodec,
  "image/png": pngCodec,
  "image/webp": webpCodec,
};

export async function decodePortableImage(
  bytes: Buffer,
  mimeType: keyof typeof codecs,
  limits: ImageLimits,
): Promise<void> {
  const decoder = await codecs[mimeType].createDecoder!(
    new MemorySource(bytes),
    limits,
    { preserveIcc: true },
  );
  // The decoder reads pixel data lazily. Consume it all to detect damaged images.
  let rows = 0;
  for await (const block of decoder.decode()) rows += block.height;
  if (rows !== decoder.height) throw new Error("Incomplete image data");
}
