# PDF-invul

Webtoepassing wat 'n PDF-vorm in die blaaier wys (PDF.js), die invulvelde outomaties
op die bediener bespeur, en invoerblokkies presies bo-oor die vorm plaas. Die ingevulde
vorm word met **pdf-lib** teruggeskryf.

## Begin

```bash
npm install
npm start          # of: npm run dev  (herlaai outomaties)
```
Maak dan http://localhost:3000 oop. In VS Code: **F5** ("Begin bediener") begin die bediener en maak die blaaier oop.

## Gebruik

1. **PDF oplaai**: die velde word outomaties bespeur en die vorm word dadelik op die bediener gestoor (`data/forms/`).
   Maak dit later weer oop via **Gestoorde vorms**.
2. **Wysig velde**: skuif, verander grootte, kopieer (Ctrl+C/V/D) of verwyder velde; stel X/Y/grootte/font in die paneel links.
   **+ Nuwe veld** en **✍ Teken hier-veld** voeg velde by.
3. Vul in en klik **Stoor** (Ctrl+S).
4. **Deel met span** gee 'n skakel (`?form=<id>&span=1`). Spanlede kan net invul, teken en stoor, nie velde verander nie.
   Elkeen stoor net die velde wat hulle self verander het, so mense kan gelyk werk sonder om mekaar te oorskryf.
5. **Laai ingevulde PDF af**: plat PDF met al die waardes en handtekeninge.

## Instellings (`.env`)

Kopieer `.env.example` na `.env`:

- `DATA_DIR`: waar vorms gestoor word (bv. 'n gedeelde OneDrive-vouer). Sonder dit: `./data/forms`.
- `OWNER_PASSWORD`: wagwoord vir die eienaar (oplaai, wysig, deel, verwyder). Spanlede het net hul skakel nodig.
- `PUBLIC_URL` / `TUNNEL_TOKEN`: vir 'n vaste Cloudflare-tunnel met 'n eie domein.

## Toegang van oral af (Cloudflare Tunnel)

1. Laai [cloudflared-windows-amd64.exe](https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe)
   af en stoor dit as `tools/cloudflared.exe`.
2. `npm run tunnel` begin die bediener plus 'n tunnel en wys die publieke adres. Deel-skakels gebruik dit outomaties.

Sonder `TUNNEL_TOKEN` is dit 'n gratis vinnige tunnel (`*.trycloudflare.com`) wat by elke herbegin 'n nuwe adres kry.
Sonder tunnel werk deel-skakels net op die kantoornetwerk (Windows Firewall moet dan poort 3000 toelaat).

## Lêers

| Lêer | Rol |
|---|---|
| `src/detect.mjs` | Bespeur velde (bestaande AcroForm-velde via pdf-lib, anders heuristies met pdfjs-dist). |
| `src/fill.mjs` | `fillFlat` skryf waardes, fonts en handtekening-prente op die bladsy. |
| `src/server.mjs` | Express-API: `POST /api/upload`, `GET /api/forms`, `GET/PUT/DELETE /api/forms/:id`, `GET /api/pdf/:id`, `GET /api/download/:id`, `GET /api/info`. |
| `public/` | Frontend: PDF.js teken die bladsye; velde word bo-oor geplaas. |

Let wel: enigiemand met die skakel kan die vorm invul. Daar is (nog) geen aanmelding nie.
