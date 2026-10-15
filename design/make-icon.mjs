// 把 design/icon.svg 转成 Tauri 需要的多尺寸 PNG，再合成 icon.ico
// 运行：node design/make-icon.mjs
import sharp from "sharp";
import pngToIco from "png-to-ico";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svgPath = join(root, "design", "icon.svg");
const iconsDir = join(root, "src-tauri", "icons");
mkdirSync(iconsDir, { recursive: true });

const sizes = [256, 128, 64, 48, 32, 24, 16];
const pngBuffers = await Promise.all(
  sizes.map((s) => sharp(svgPath, { density: 384 }).resize(s, s).png().toBuffer())
);
// 最高分辨率 png 作为 icon.png
writeFileSync(join(iconsDir, "icon.png"), pngBuffers[0]);
writeFileSync(join(iconsDir, "128x128.png"), pngBuffers[1]);
writeFileSync(join(iconsDir, "128x128@2x.png"), pngBuffers[0]);
writeFileSync(join(iconsDir, "32x32.png"), pngBuffers[4]);

const ico = await pngToIco(pngBuffers);
writeFileSync(join(iconsDir, "icon.ico"), ico);
console.log("icon.png / 128x128.png / 32x32.png / icon.ico 已生成");
