/** A standalone ArrayBuffer. Blob and sql.js reject a Uint8Array view over SharedArrayBuffer. */
export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(data.byteLength);
  new Uint8Array(copy).set(data);
  return copy;
}
