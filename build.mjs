import {copyFile, mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export const assets = [
  '.nojekyll', 'index.html', 'app.js', 'cache.js', 'locations.js', 'lookup.js', 'model.js',
  'nearby.js', 'source.js', 'styles.css', 'favicon.svg', 'ru-city-centers.json',
  'leaflet.js', 'leaflet.css', 'MarkerCluster.css', 'leaflet.markercluster.js',
  'leaflet.LICENSE.txt', 'leaflet.markercluster.LICENSE.txt', 'demand.json', 'coordinates.json',
];

export async function build(directory = new URL('./dist/', import.meta.url)) {
  await mkdir(directory, {recursive: true});
  await Promise.all(assets.map(name => copyFile(new URL(name, import.meta.url), new URL(name, directory))));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await build();
