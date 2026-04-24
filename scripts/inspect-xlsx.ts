/**
 * One-off inspector for the Coal Offloading spreadsheet.
 * Dumps sheet names, dimensions, cell values, and formulas so we can
 * reverse-engineer the calculation model before implementing in TS.
 */
import * as XLSX from "xlsx";

const file = process.argv[2];
if (!file) { console.error("usage: tsx scripts/inspect-xlsx.ts <file.xlsx>"); process.exit(1); }

const wb = XLSX.readFile(file, { cellFormula: true, cellNF: true, cellStyles: false });

for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  if (!ws["!ref"]) { console.log(`\n=== Sheet: ${name} (empty) ===`); continue; }
  const range = XLSX.utils.decode_range(ws["!ref"]);
  console.log(`\n=== Sheet: ${name}  range: ${ws["!ref"]}  (${range.e.r - range.s.r + 1} rows × ${range.e.c - range.s.c + 1} cols) ===`);

  for (let r = range.s.r; r <= range.e.r; r++) {
    const cols: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell) continue;
      const v = cell.v !== undefined ? String(cell.v) : "";
      const f = cell.f ? ` =${cell.f}` : "";
      cols.push(`${addr}: ${v}${f}`);
    }
    if (cols.length) console.log(`  row ${r + 1}: ${cols.join(" | ")}`);
  }
}
