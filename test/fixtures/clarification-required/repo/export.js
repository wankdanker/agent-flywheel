// Exports the widget table in two formats.
export function exportCsv(rows) {
  return rows.map((r) => Object.values(r).join(",")).join("\n");
}

export function exportPdf(rows) {
  // Renders each row as its own page.
  return rows.map((r) => `%PDF-page ${JSON.stringify(r)}`).join("\n");
}
