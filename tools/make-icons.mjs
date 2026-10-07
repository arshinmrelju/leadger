#!/usr/bin/env node
/**
 * Rasterise the app icons for the PWA manifest.
 *
 * WHY A SCRIPT AND NOT CHECKED-IN BYTES ALONE
 * The icons are derived from assets/logo.svg. If they were only committed as
 * PNGs, the next person to restyle the logo would have no way to know how
 * they were produced, and would either hand-edit binary files or ship a
 * manifest whose icon no longer matches the app. So the PNGs are committed
 * (they must be, they are served to browsers) but they are also buildable:
 *
 *     node tools/make-icons.mjs
 *
 * REQUIRES headless Chrome or Edge. It is a build-time-only dependency and
 * nothing in the app depends on it at runtime — the app is still a static
 * site with no build step, this just regenerates three files.
 *
 * WHY THE MASKABLE ICON IS NOT THE SAME PICTURE
 * A maskable icon is cropped to whatever shape the platform picks: a circle
 * on Android, a rounded squircle on Windows. Anything in the outer ~20% can
 * be cut off. The regular logo fills its canvas with a rounded square, so
 * using it as-is would lose its corners. icon-maskable.svg therefore
 * re-composes the mark: full-bleed background, mark scaled to 1.3x and
 * centred so its furthest point lands 190.5px from the centre, just inside
 * the 204.8px safe radius. The arithmetic is written out in that SVG; the
 * scale is deliberately close to its 1.398 ceiling and should not be
 * "tidied up" in either direction.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "assets");

/** Browsers that can do it, in preference order. */
const BROWSERS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  process.env.CHROME_PATH,
].filter(Boolean);

function findBrowser() {
  const found = BROWSERS.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      "No headless Chrome or Edge found.\n" +
        "Install Chrome or Edge, or set CHROME_PATH to the executable and re-run.",
    );
  }
  return found;
}

/**
 * A full-bleed page with the SVG sized edge to edge.
 *
 * The wrapper matters: screenshotting the .svg file directly renders it as a
 * document with the browser's default 8px body margin, which silently
 * letterboxes the icon and leaves a transparent rim.
 */
function page(svg, size) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:transparent;}
  svg{display:block;width:${size}px;height:${size}px;}
</style></head><body>${svg}</body></html>`;
}

function shoot(browser, svgPath, size, outPath) {
  const dir = mkdtempSync(join(tmpdir(), "trustx-icons-"));
  const htmlPath = join(dir, "icon.html");
  const pngPath = join(dir, "icon.png");
  try {
    writeFileSync(htmlPath, page(readFileSync(svgPath, "utf8"), size));
    execFileSync(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-sandbox",
        /* Transparent, so the rounded square in the logo is the icon's own
           edge rather than a white box around it. */
        "--default-background-color=00000000",
        `--window-size=${size},${size}`,
        `--screenshot=${pngPath}`,
        `file:///${htmlPath.replace(/\\/g, "/")}`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    if (!existsSync(pngPath)) throw new Error(`no screenshot produced for ${svgPath}`);
    return readFileSync(pngPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const browser = findBrowser();
console.log(`using ${browser}`);

const jobs = [
  { svg: join(OUT, "logo.svg"), size: 192, out: join(OUT, "icon-192.png") },
  { svg: join(OUT, "logo.svg"), size: 512, out: join(OUT, "icon-512.png") },
  { svg: join(OUT, "icon-maskable.svg"), size: 512, out: join(OUT, "icon-maskable-512.png") },
  /* Owner console set — the second PWA (manifest-admin.webmanifest) needs
     its own 192 + 512 PNGs or the browser will not offer to install it. */
  { svg: join(OUT, "logo-owner.svg"), size: 192, out: join(OUT, "icon-owner-192.png") },
  { svg: join(OUT, "logo-owner.svg"), size: 512, out: join(OUT, "icon-owner-512.png") },
  { svg: join(OUT, "icon-maskable-owner.svg"), size: 512, out: join(OUT, "icon-maskable-owner-512.png") },
];

for (const { svg, size, out } of jobs) {
  if (!existsSync(svg)) throw new Error(`missing source artwork: ${svg}`);
  const png = shoot(browser, svg, size, out);
  writeFileSync(out, png);
  console.log(`wrote ${out.replace(ROOT + "\\", "")} (${size}x${size}, ${png.length} bytes)`);
}

console.log("\nDone. Commit the regenerated PNGs alongside the script.");