/**
 * Parse AEMO's multi-table CSV format.
 *
 * Each file contains rows prefixed with a record type:
 *   C  – comment / header metadata
 *   I  – column header for the table that follows
 *   D  – data row
 *
 * Returns Map<tableName, rows[]> where each row is a Record<string, string>.
 *
 * `rowFilter` is an optional predicate run per data row before it's added —
 * use it to drop rows you don't need at parse time (critical for big files
 * like Next_Day_PreDispatch where we only want LYB1/LYB2 out of ~330 DUIDs).
 */
export type RowFilter = (table: string, row: Record<string, string>) => boolean;

export function parseNEMWebCSV(
  text: string,
  rowFilter?: RowFilter,
): Map<string, Record<string, string>[]> {
  const tables = new Map<string, Record<string, string>[]>();
  let currentTable = "";
  let columns: string[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const fields = parseCSVLine(line);
    const recordType = fields[0];

    if (recordType === "I") {
      currentTable = `${fields[1]}_${fields[2]}`.toUpperCase();
      columns = fields.slice(3).map((c) => c.toUpperCase());
      if (!tables.has(currentTable)) {
        tables.set(currentTable, []);
      }
    } else if (recordType === "D" && columns.length > 0) {
      const values = fields.slice(3);
      const row: Record<string, string> = {};
      for (let i = 0; i < columns.length; i++) {
        row[columns[i]] = values[i] ?? "";
      }
      if (rowFilter && !rowFilter(currentTable, row)) continue;
      tables.get(currentTable)!.push(row);
    }
  }

  return tables;
}

/** Parse a single CSV line, handling quoted fields */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}
