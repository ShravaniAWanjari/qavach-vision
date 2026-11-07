// Fails when a colour literal appears outside src/styles/tokens.css (the one place colours live).
// src/scenes/Scene.tsx is the illustrated camera picture, not UI, so it is exempt.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const EXEMPT = new Set(['tokens.css', 'Scene.tsx']);
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
const bad = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(css|ts|tsx)$/.test(name) && !EXEMPT.has(name)) {
      readFileSync(p, 'utf8').split('\n').forEach((line, i) => LITERAL.test(line) && bad.push(`${p}:${i + 1}  ${line.trim().slice(0, 100)}`));
    }
  }
};
walk('src');
// tokens.css itself may hold only the eight colours and white.
const ALLOWED = new Set(['#dc2626', '#2563eb', '#35b9f1', '#0ea5e9', '#005972', '#009fe3', '#f4ec94', '#0f242a', '#0c323d', '#899397', '#ea580c', '#b45309', '#ffc72c', '#16a34a', '#7c3aed', '#64748b', '#e5e9f0', '#000000', '#ffffff']);
for (const m of readFileSync('src/styles/tokens.css', 'utf8').matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
  if (!ALLOWED.has(m[0].toLowerCase())) bad.push(`src/styles/tokens.css  ${m[0]} is not one of the palette colours`);
}
if (bad.length) { console.error(`Colour literals outside tokens.css:\n${bad.join('\n')}`); process.exit(1); }
console.log('colours ok: only tokens.css defines colour');
