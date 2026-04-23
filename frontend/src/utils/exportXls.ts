import * as XLSX from 'xlsx';

export function exportToXls(rows: Record<string, unknown>[], filename: string) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Лист1');
  XLSX.writeFile(wb, `${filename}.xlsx`);
}
