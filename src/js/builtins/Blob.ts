export function lines(this: Blob) {
  if (!$inheritsBlob(this)) throw $ERR_INVALID_THIS("Blob");
  return this.stream().lines();
}
