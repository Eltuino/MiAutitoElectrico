// Une los archivos out_*.json (peajes por concesión, tarifas MOP 2026 + ubicaciones OSM)
// en public/data/tolls.json, que usa la app.
// Uso: node scripts/build-tolls.mjs <carpeta-con-out_*.json>
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('Indica la carpeta con los out_*.json');
const files = (await readdir(dir)).filter((f) => /^out_.*\.json$/.test(f));

const ACCENTS = { Puchuncavi: 'Puchuncaví', 'San Jose': 'San José', 'Las Aranas': 'Las Arañas', Quilpue: 'Quilpué', Pilpilco: 'Pilpilco' };
function niceName(raw) {
  let n = String(raw).replace(/^(plaza de )?peaje\s+/i, '').trim();
  const stripped = n.replace(/^(troncal|lateral)\s+/i, '').trim();
  // "Troncal Sur" se mantiene: "Sur" solo no dice nada
  if (stripped && !/^(sur|norte|oriente|poniente)$/i.test(stripped)) n = stripped;
  for (const [a, b] of Object.entries(ACCENTS)) n = n.replace(new RegExp(`\\b${a}\\b`, 'g'), b);
  return n || raw;
}
const byId = new Map();
const problems = [];
for (const f of files) {
  const j = JSON.parse(await readFile(join(dir, f), 'utf8'));
  for (const t of j.tolls ?? []) {
    const ok = t.osm && isFinite(t.lat) && isFinite(t.lng) && Number(t.price) > 0 && ['troncal', 'lateral', 'portico'].includes(t.kind);
    if (!ok) {
      problems.push(`${f}: ${t.osm ?? '?'} ${t.name ?? ''} (${t.price})`);
      continue;
    }
    if (byId.has(t.osm)) {
      problems.push(`${f}: duplicado ${t.osm} ${t.name} (se mantiene el primero)`);
      continue;
    }
    const clean = {
      osm: t.osm,
      lat: +(+t.lat).toFixed(6),
      lng: +(+t.lng).toFixed(6),
      // "Peaje Troncal Lo Prado" → "Lo Prado" (la app ya antepone "Peaje")
      name: t.kind === 'portico' ? t.name : niceName(t.name),
      concession: t.concession,
      road: t.road,
      kind: t.kind,
      price: Math.round(t.price),
    };
    if (t.pricePeak > 0) clean.pricePeak = Math.round(t.pricePeak);
    if (t.priceSat > 0) clean.priceSat = Math.round(t.priceSat);
    if (t.peak?.length) clean.peak = t.peak;
    // punta solo en temporada alta / fines de semana largos (no representable por día y hora)
    if (clean.pricePeak && !t.peak?.length) clean.seasonal = true;
    if (t.sat?.length) clean.sat = t.sat;
    if (t.confidence && t.confidence !== 'alta') clean.confidence = t.confidence;
    byId.set(t.osm, clean);
  }
}
const tolls = [...byId.values()];

// Sistemas con cobro entrada→salida (AVO), desde out_urbanas.json
const od = [];
for (const f of files) {
  const j = JSON.parse(await readFile(join(dir, f), 'utf8'));
  for (const [concession, list] of Object.entries(j.odGantries ?? {})) {
    const rates = j.perKm?.[concession];
    if (!rates) continue;
    od.push({
      concession,
      road: 'Américo Vespucio Oriente',
      gantries: list.filter((g) => g.osm).map((g) => ({ osm: g.osm, lat: g.lat, lng: g.lng, portico: g.portico, roles: g.roles ?? [] })),
      pairs: (j.odTariffs?.[concession] ?? []).map((x) => ({ entry: x.entry, exit: x.exit, tbfp: Math.round(x.tbfp), tbp: Math.round(x.tbp), km: x.km })),
      perKm: { tbfp: rates.tbfp, tbp: rates.tbp },
      peak: j.defaults?.[concession]?.peak ?? [],
    });
  }
}
const out = new URL('../public/data/tolls.json', import.meta.url);
await writeFile(out, JSON.stringify({ updated: new Date().toISOString().slice(0, 10), source: 'Tarifas 2026 MOP – Dirección General de Concesiones (concesiones.mop.gob.cl/peajes-y-porticos) + ubicaciones OpenStreetMap', tolls, od }));
const kinds = tolls.reduce((a, t) => ((a[t.kind] = (a[t.kind] ?? 0) + 1), a), {});
console.log(`Guardados ${tolls.length} puntos de cobro`, kinds, `· tramos entrada→salida: ${od.map((o) => `${o.concession} (${o.gantries.length} pórticos, ${o.pairs.length} pares)`).join(', ')}`);
if (problems.length) console.log('Revisar:\n  ' + problems.join('\n  '));
