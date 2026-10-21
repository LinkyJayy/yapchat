// Builds public/emoji/data.json (picker metadata) from emojibase-data, keeping only
// emoji that have a Noto 3D image in public/emoji/3d.
// Usage: node tools/build-emoji-data.js <path-to-emojibase-data-package>
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const pkg = process.argv[2];
const compact = JSON.parse(fs.readFileSync(path.join(pkg, 'en/compact.json'), 'utf8'));
const iamcal = JSON.parse(fs.readFileSync(path.join(pkg, 'en/shortcodes/iamcal.json'), 'utf8'));
const base = JSON.parse(fs.readFileSync(path.join(pkg, 'en/shortcodes/emojibase.json'), 'utf8'));
const dir = path.join(__dirname, '..', 'public', 'emoji', '3d');
const have = new Set(fs.readdirSync(dir).map((f) => f.replace(/\.webp$/, '')));
const file = (hex) => hex.toLowerCase().split('-').filter((x) => x !== 'fe0f').map((x) => x.padStart(4, '0')).join('-');
const codes = (hex) => [].concat(iamcal[hex] || [], base[hex] || []).filter((v, i, a) => a.indexOf(v) === i);
// emojibase groups: 0 smileys, 1 people, 2 component, 3 animals, 4 food, 5 travel, 6 activities, 7 objects, 8 symbols, 9 flags
const groupMap = { 0: 'people', 1: 'people', 3: 'nature', 4: 'food', 5: 'travel', 6: 'activities', 7: 'objects', 8: 'symbols', 9: 'flags' };
const out = [];
for (const e of compact) {
  if (e.group === 2 || e.group == null) continue;
  const f = file(e.hexcode);
  if (!have.has(f)) continue;
  const item = { e: e.unicode, n: e.label, s: codes(e.hexcode), g: groupMap[e.group], k: (e.tags || []).join(' ') };
  if (e.skins) {
    const skins = [];
    for (const s of e.skins) {
      if (Array.isArray(s.tone) && s.tone.length > 1) continue;
      const t = Array.isArray(s.tone) ? s.tone[0] : s.tone;
      if (have.has(file(s.hexcode))) skins[t - 1] = s.unicode;
    }
    if (skins.filter(Boolean).length === 5) item.t = skins;
  }
  out.push(item);
}
fs.writeFileSync(path.join(__dirname, '..', 'public', 'emoji', 'data.json'), JSON.stringify(out));
console.log('emoji:', out.length);
