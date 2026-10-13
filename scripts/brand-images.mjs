#!/usr/bin/env node
// Brand images: renders the SVG sources in docs/assets/src/ to the PNGs in docs/assets/images/
// with headless Chrome, then checks each PNG's size in pixels and that it stays under 300 kB.
//
//   node scripts/brand-images.mjs
//
// CHROME points to a Chrome or Chromium binary; without it the usual macOS and Linux locations are
// tried. Text uses Helvetica Neue / Helvetica / Arial, so the result depends a little on the fonts
// installed; the PNGs are committed, and the script only needs to run after a source changes.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = fileURLToPath(new URL('../docs/assets/src/', import.meta.url));
const OUT = fileURLToPath(new URL('../docs/assets/images/', import.meta.url));
const MAX_BYTES = 300 * 1024;

const IMAGES = [
  { src: 'og.svg', out: 'og.png', width: 1200, height: 630 },
  { src: 'social-preview.svg', out: 'social-preview.png', width: 1280, height: 640 },
  { src: 'favicon.svg', out: 'favicon-32.png', width: 32, height: 32 },
  { src: 'app-icon.svg', out: 'apple-touch-icon.png', width: 180, height: 180 },
  { src: 'app-icon.svg', out: 'ph-thumbnail.png', width: 240, height: 240 },
];
// Served as SVG too (`<link rel="icon" type="image/svg+xml">`).
const COPIES = [{ src: 'favicon.svg', out: 'favicon.svg' }];

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
];

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate.startsWith('/') ? existsSync(candidate) : spawnSync(candidate, ['--version']).status === 0) {
      return candidate;
    }
  }
  console.error('No Chrome or Chromium found; set CHROME to its binary.');
  process.exit(2);
}

/** Width and height from the IHDR chunk of a PNG. */
function pngSize(file) {
  const bytes = readFileSync(file);
  if (bytes.toString('ascii', 1, 4) !== 'PNG') throw new Error(`${file} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const chrome = findChrome();
const profile = mkdtempSync(join(tmpdir(), 'brand-images-'));
let failed = false;
try {
  for (const { src, out, width, height } of IMAGES) {
    const target = join(OUT, out);
    // The SVG's own width/height are its design size; a page that draws it at the target size
    // scales it (the icons are drawn at 64 px and rendered at 32, 180 and 240).
    const page = join(profile, `${out}.html`);
    writeFileSync(
      page,
      `<html><body style="margin:0;background:transparent"><img src="${pathToFileURL(join(SRC, src))}" width="${width}" height="${height}" style="display:block"></body></html>`,
    );
    const run = spawnSync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--default-background-color=00000000',
        `--user-data-dir=${profile}`,
        `--window-size=${width},${height}`,
        `--screenshot=${target}`,
        pathToFileURL(page).href,
      ],
      { encoding: 'utf8' },
    );
    if (run.status !== 0 || !existsSync(target)) {
      console.error(`${out}: Chrome failed\n${run.stderr}`);
      failed = true;
      continue;
    }
    const size = pngSize(target);
    const bytes = statSync(target).size;
    const ok = size.width === width && size.height === height && bytes < MAX_BYTES;
    if (!ok) failed = true;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${out} ${size.width}x${size.height} ${(bytes / 1024).toFixed(1)} kB`);
  }
  for (const { src, out } of COPIES) {
    copyFileSync(join(SRC, src), join(OUT, out));
    console.log(`ok   ${out} (copy of ${src})`);
  }
} finally {
  rmSync(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
