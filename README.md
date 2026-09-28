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

## Hoe dit werk

| Lêer | Rol |
|---|---|
| `src/detect.mjs` | Bespeur velde. Gebruik bestaande AcroForm-velde (pdf-lib) as daar is; anders heuristies met pdfjs-dist: `____`-lyne → teksvelde, leë tabelselle met 'n etiket regs → merkblokkies, aangrensende leë selle → "kam"-veld (een karakter per blokkie). |
| `src/fill.mjs` | `fillFlat` skryf die waardes op die bladsy; `makeFillable` skep regte AcroForm-velde sodat die PDF in Acrobat ens. invulbaar is. |
| `src/server.mjs` | Express-API: `POST /api/upload`, `POST /api/sample`, `GET /api/pdf/:id`, `POST /api/fill/:id` (`mode: flat \| fillable`). |
| `public/` | Frontend: PDF.js lewer elke bladsy op 'n canvas; velde word van PDF-punte na skermpiksels omgeskakel met `viewport.convertToViewportRectangle`. |

**Wysig velde** (merkblokkie bo): sleep om te skuif, sleep die regterrand om breedte te verander, × om te verwyder,
dubbelklik op die bladsy om 'n teksveld by te voeg (Shift+dubbelklik = merkblokkie). Die aangepaste velde word saam
met die waardes na die bediener gestuur.

`samples/sapex-aansoek.pdf` is die Sapex Cape kredietaansoek (64 velde oor 5 bladsye word bespeur).

Let wel: opgelaaide PDF's word net in geheue gehou (verdwyn wanneer die bediener herbegin).
