import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { toArrayBuffer } from './bytes';

const require = createRequire(import.meta.url);
let pending: Promise<SqlJsStatic> | null = null;

export function loadSqlNode(): Promise<SqlJsStatic> {
  if (!pending) {
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    pending = initSqlJs({
      wasmBinary: toArrayBuffer(readFileSync(wasmPath)),
      useOldExtensionFunctions: true,
    });
  }
  return pending;
}
