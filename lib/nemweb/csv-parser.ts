/**
 * Parse AEMO's multi-table CSV format.
 *
 * Each file contains rows prefixed with a record type:
 *   C  – comment / header metadata
 *   I  – column header for the table that follows
 *   D  – data row
 *
 * Returns Map<tableName, rows[]> where each row is a Record<string, string>.
 */
export function parseNEMWebCSV(text: string): Map<string, Record<string, string>[]> {
  const tables = new Map<string, Record<string, string>[]>();
  let currentTable = "";
  let columns: string[] = [];

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    const fields = parseCSVLine(line);
    const recordType = fields[0];

    if (recordType === "I") {
      // fields[2] is the table name (e.g. "REGIONSOLUTION")
      // Build a compound key from fields[1] (report) + fields[2] (table)
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
      tables.get(currentTable)!.push(row);
    }
    // C and other row types are ignored
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
