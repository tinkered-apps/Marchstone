# Vendored libraries

`npm audit` does not see these files, so check them by hand: compare the
version below with the project's latest release and its security advisories.

| Files | Library and version | From | In the project since | Licence |
|---|---|---|---|---|
| `leaflet.js`, `leaflet.css`, `images/` | [Leaflet](https://leafletjs.com) 1.9.4 | `dist/` of [leaflet@1.9.4](https://www.npmjs.com/package/leaflet/v/1.9.4) | 2026-08-20 | BSD-2-Clause, [LICENSE-leaflet.txt](LICENSE-leaflet.txt) |

Each file is an unmodified copy: its SHA-256 matches the file in the npm
package (compared on 2026-10-13).

The Barlow and Barlow Condensed fonts in `fonts/` are Latin and Latin Extended
subsets under the SIL Open Font License 1.1 ([OFL.txt](fonts/OFL.txt)).

When replacing Leaflet, copy the released files unchanged, update the row
above, and bump `APP_VERSION` and `CACHE` together so installed phones fetch the
new files.
