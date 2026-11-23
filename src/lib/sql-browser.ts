import initSqlJs, { type SqlJsStatic } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

let pending: Promise<SqlJsStatic> | null = null;

export function loadSql(): Promise<SqlJsStatic> {
  if (!pending) {
    pending = initSqlJs({ locateFile: () => wasmUrl, useOldExtensionFunctions: true });
  }
  return pending;
}
