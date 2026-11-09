import sharp from "sharp";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "public/icon.png");
const output = path.join(root, "public/icons");
await mkdir(output, { recursive: true });

// macOS Dock artwork needs breathing room inside the square icon canvas.
const dock = await sharp(source).resize(864, 864).extend({
  top: 80, bottom: 80, left: 80, right: 80,
  background: { r: 0, g: 0, b: 0, alpha: 0 },
}).png().toBuffer();
await sharp(dock).toFile(path.join(output, "mac-dock.png"));

// Trim source padding so the small menu bar artwork fills its 20-point canvas.
const tray = await sharp(source).trim().png().toBuffer();
for (const scale of [1, 2]) {
  await sharp(tray).resize(20 * scale, 20 * scale, { fit: "contain", background: "#00000000" })
    .toFile(path.join(output, scale === 1 ? "mac-tray.png" : "mac-tray@2x.png"));
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
