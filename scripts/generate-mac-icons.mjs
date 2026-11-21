import { Buffer } from "node:buffer";
import sharp from "sharp";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "assets/dramabridge-logo-source.png");
const output = path.join(root, "public/icons");
await mkdir(output, { recursive: true });

// The selected artwork has uneven transparent padding. Crop to its tile before
// placing it on the macOS icon grid and the Windows application icon canvas.
const tile = await sharp(source)
  .extract({ left: 48, top: 57, width: 1149, height: 1151 })
  .png()
  .toBuffer();
const dock = await sharp(tile).resize(824, 824).extend({
  top: 100, bottom: 100, left: 100, right: 100,
  background: { r: 0, g: 0, b: 0, alpha: 0 },
}).png().toBuffer();
await sharp(dock).toFile(path.join(output, "mac-dock.png"));

const windowsIcon = await sharp(tile).resize(920, 920).extend({
  top: 52, bottom: 52, left: 52, right: 52,
  background: { r: 0, g: 0, b: 0, alpha: 0 },
}).png().toBuffer();
await writeFile(path.join(root, "public/icon.png"), windowsIcon);

// Extract the light mark from the dark app tile for a macOS template image.
const { data, info } = await sharp(source)
  .extract({ left: 200, top: 100, width: 850, height: 950 })
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
for (let index = 0; index < data.length; index += 4) {
  const luminance = 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
  data[index + 3] = Math.round(data[index + 3] * Math.max(0, Math.min(1, (luminance - 90) / 65)));
  data[index] = 0;
  data[index + 1] = 0;
  data[index + 2] = 0;
}
const tray = await sharp(data, { raw: info }).trim().png().toBuffer();
for (const scale of [1, 2]) {
  await sharp(tray).resize(20 * scale, 20 * scale, { fit: "contain", background: "#00000000" })
    .toFile(path.join(output, scale === 1 ? "mac-tray.png" : "mac-tray@2x.png"));
}

// Include PNG-encoded representations for modern Windows icon sizes.
const windowsSizes = [16, 24, 32, 48, 64, 128, 256];
const images = await Promise.all(windowsSizes.map(size => sharp(windowsIcon).resize(size, size).png().toBuffer()));
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = header.length;
for (const [index, image] of images.entries()) {
  const entry = 6 + index * 16;
  header[entry] = windowsSizes[index] === 256 ? 0 : windowsSizes[index];
  header[entry + 1] = header[entry];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += image.length;
}
await sharp(windowsIcon).resize(128, 128).png().toFile(path.join(root, "src/assets/dramabridge-logo.png"));
await writeFile(path.join(root, "build/icons/icon.ico"), Buffer.concat([header, ...images]));
for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  await sharp(windowsIcon).resize(size, size).png().toFile(path.join(root, `build/icons/${size}x${size}.png`));
}

// Package the same Dock artwork for Finder and installed applications.
const temporary = await mkdtemp(path.join(tmpdir(), "dramabridge-icons-"));
try {
  const iconset = path.join(temporary, "icon.iconset");
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      await sharp(dock).resize(size * scale).toFile(
        path.join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`),
      );
    }
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(root, "build/icons/icon.icns")]);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
