/**
 * Escapes a cell value for safe CSV export.
 * - Prevents CSV Formula Injection by prepending a single quote if string begins with =, +, -, @, \t, or \r
 * - Wraps in double quotes and escapes internal double quotes if cell contains comma, quote, newline, or prepended single quote
 */
export function escapeCsvCell(val: any): string {
  if (val === null || val === undefined) return "";
  let s = String(val);
  // Formula Injection prevention: prepend single quote if cell begins with =, +, -, @, \t, \r
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r") || s.startsWith("'")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
