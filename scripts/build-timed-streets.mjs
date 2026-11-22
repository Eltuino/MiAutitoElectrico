// Calles con sentido de tránsito según la hora (reversibles), desde OpenStreetMap.
// Valhalla (el servicio de rutas) no respeta `oneway:conditional`, así que la app revisa cada ruta
// contra este archivo y, si pasa en contra del sentido a esa hora, la recalcula evitando ese tramo.
// Uso: node scripts/build-timed-streets.mjs   → public/data/timed-streets.json
import { writeFile } from 'node:fs/promises';

const HOSTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
// Chile continental
const BBOX = '-56.0,-76.0,-17.4,-66.0';
const QUERY = `[out:json][timeout:240];
(
  way["highway"]["oneway:conditional"](${BBOX});
  way["highway"]["oneway"="reversible"](${BBOX});
);
out tags geom;`;

async function overpass(q) {
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const host of HOSTS) {
      try {
        const r = await fetch(host, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(q),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': 'MiAutitoElectrico-data/1.0' },
        });
        const t = await r.text();
        if (r.ok && t.startsWith('{')) return JSON.parse(t).elements;
        console.log(`  ${host}: ${r.status}, reintento…`);
      } catch (e) {
        console.log(`  ${host}: ${e.message}, reintento…`);
      }
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
  throw new Error('Overpass no respondió');
}

const DAY = { mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6, su: 7 };

const MONTH = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** "Mo-Fr" / "Tu,Fr" / "Mo-Fr,Su" / "Sa-Su,PH" → [1..7] (los feriados no se conocen: se ignoran) */
function parseDays(s) {
  const out = new Set();
  for (const part of s.split(',')) {
    if (/^PH$/i.test(part.trim())) continue;
    const [a, b] = part.split('-').map((x) => DAY[x.trim().toLowerCase().slice(0, 2)]);
    if (!a) return null;
    if (b) for (let d = a; ; d = (d % 7) + 1) {
      out.add(d);
      if (d === b) break;
    }
    else out.add(a);
  }
  return [...out].sort();
}

/** "07:30-10:00,17:00-21:00" → [[450,600],[1020,1260]] */
function parseTimes(s) {
  const out = [];
  for (const part of s.split(',')) {
    const m = part.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    out.push([+m[1] * 60 + +m[2], +m[3] * 60 + +m[4]]);
  }
  return out;
}

/**
 * Una condición de opening_hours simple → [{d, t, m?}]
 *   "Mo-Fr 07:30-10:00;PH off" · "Mar 1-Dec 31 Mo-Fr 07:00-08:15" (año escolar) · "Dec 1 - Mar 31"
 */
function parseCondition(cond) {
  const out = [];
  for (let rule of cond.split(';')) {
    rule = rule.trim();
    if (!rule || /^PH(\s+off)?$/i.test(rule)) continue; // feriados: no los conocemos, se tratan como día normal
    // rango de fechas al inicio: "Mar 1-Dec 31", "Apr 24-May 04:", "Nov 01 - Mar 31"
    let months;
    const mr = rule.match(/^([A-Za-z]{3})\s*(\d{1,2})?\s*-\s*([A-Za-z]{3})\s*(\d{1,2})?\s*:?\s*/);
    if (mr && MONTH[mr[1].toLowerCase()] && MONTH[mr[3].toLowerCase()]) {
      months = [MONTH[mr[1].toLowerCase()] * 100 + +(mr[2] ?? 1), MONTH[mr[3].toLowerCase()] * 100 + +(mr[4] ?? 31)];
      rule = rule.slice(mr[0].length).trim();
    }
    const m = rule.match(/^([A-Za-z]{2}(?:\s*[-,]\s*[A-Za-z]{2})*)?\s*([\d:,\s-]+)?$/);
    if (!m) return null;
    if (!m[1] && !(m[2] ?? '').trim() && !months) return null;
    const d = m[1] ? parseDays(m[1].replace(/\s/g, '')) : [1, 2, 3, 4, 5, 6, 7];
    const t = m[2] && m[2].trim() ? parseTimes(m[2].replace(/\s/g, '')) : [[0, 1440]];
    if (!d || !d.length || !t) return null;
    out.push(months ? { d, t, m: months } : { d, t });
  }
  return out;
}

/** Separa "yes @ (…);-1 @ (…)" en partes (los ; dentro de paréntesis no cuentan) */
function splitTop(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ';' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

const normOneway = (v) => {
  v = String(v ?? '').trim().toLowerCase();
  if (v === 'yes' || v === '1' || v === 'true') return 'yes';
  if (v === '-1' || v === 'reverse') return '-1';
  if (v === 'no' || v === 'false' || v === 'reversible' || v === 'alternating') return 'no';
  return null;
};

console.log('Consultando OpenStreetMap…');
const els = await overpass(QUERY);
const ways = [];
const problems = [];
for (const e of els) {
  const t = e.tags ?? {};
  let base = normOneway(t.oneway);
  if (!base) base = t.junction === 'roundabout' || t.highway === 'motorway' ? 'yes' : 'no';
  const rules = [];
  if (t['oneway:conditional']) {
    // a veces la condición viene sin paréntesis: "yes @ Mo-Fr 07:30-10:00"
    const raw = t['oneway:conditional'];
    const parts = /@\s*\(/.test(raw) ? splitTop(raw) : [raw];
    for (const p of parts) {
      const m = p.match(/^\s*([^@]+?)\s*@\s*\(?\s*(.+?)\s*\)?\s*$/);
      const v = m && normOneway(m[1]);
      const conds = m && parseCondition(m[2]);
      if (!v || !conds) {
        problems.push(`way/${e.id} ${t.name ?? ''}: "${raw}"`);
        continue;
      }
      for (const c of conds) rules.push(c.m ? { v, d: c.d, t: c.t, m: c.m } : { v, d: c.d, t: c.t });
    }
  }
  if (!rules.some((r) => r.v !== base) && t.oneway !== 'reversible') continue; // no cambia nada
  const c = (e.geometry ?? []).map((g) => [+g.lon.toFixed(6), +g.lat.toFixed(6)]);
  if (c.length < 2) continue;
  ways.push({ id: e.id, name: t.name, base, rules, c });
}

// una respuesta cortada de Overpass no debe borrar los datos buenos que ya hay
if (ways.length < 300) {
  console.error(`Solo llegaron ${ways.length} calles: algo falló en la consulta, no reemplazo el archivo.`);
  process.exit(1);
}
const out = new URL('../public/data/timed-streets.json', import.meta.url);
await writeFile(
  out,
  JSON.stringify({
    updated: new Date().toISOString().slice(0, 10),
    source: 'OpenStreetMap (oneway:conditional, oneway=reversible) © colaboradores de OpenStreetMap',
    ways,
  }),
);
console.log(`Guardadas ${ways.length} calles con sentido según la hora (de ${els.length} vías)`);
if (problems.length) console.log(`No entendí ${problems.length} condiciones (se ignoran):\n  ` + problems.slice(0, 30).join('\n  '));
