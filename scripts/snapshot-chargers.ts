// Descarga el estado actual de los cargadores públicos de Chile (SEC) y guarda una copia
// compacta en public/data/chargers-snapshot.json (respaldo cuando no hay conexión).
// Uso: npm run snapshot   (o: node scripts/snapshot-chargers.ts ruta/a/data.json)
import { readFile, writeFile } from 'node:fs/promises';
import { slimStations } from '../src/lib/slim.ts';

const src = process.argv[2];
const raw = src
  ? JSON.parse(await readFile(src, 'utf8'))
  : await (await fetch('https://cargadorespublicos.cl/api/data')).json();
const stations = slimStations(raw);
const out = new URL('../public/data/chargers-snapshot.json', import.meta.url);
await writeFile(out, JSON.stringify({ ts: Date.now(), stations }));
console.log(`Guardados ${stations.length} cargadores en public/data/chargers-snapshot.json`);
