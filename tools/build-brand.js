#!/usr/bin/env node
// Regenerates apps-script/Brand.html (logo images as JSON) from the PNGs in brand/ (run after changing a logo file).
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const files = { wordmarkWhite: 'studio-wordmark-white.png', wordmarkPurple: 'studio-wordmark-purple.png', badge: 'cdx-badge.png' };
const images = {};
for (const [k, f] of Object.entries(files)) images[k] = fs.readFileSync(path.join(root, 'brand', f)).toString('base64');
const out = JSON.stringify(images, null, 1) + '\n';
fs.writeFileSync(path.join(root, 'apps-script', 'Brand.html'), out);
console.log('Wrote apps-script/Brand.html (' + Math.round(out.length / 1024) + ' KB)');
