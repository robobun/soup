// Hardcoded module "node:sea"
//
// The single-executable application is what `bun build --compile` makes, and its assets are the files
// embedded in it: a key is the name `Bun.embeddedFiles` gives the file.
const { validateString } = require("internal/validators");

const isSea = $bindgen("node_sea.bind.ts", "isSea");
const getAssetInternal = $bindgen("node_sea.bind.ts", "getAsset");
const getAssetAsBlobInternal = $bindgen("node_sea.bind.ts", "getAssetAsBlob");
const getAssetKeysInternal = $bindgen("node_sea.bind.ts", "getAssetKeys");

function notInSea() {
  return $ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION(
    "Operation cannot be invoked when not in a single-executable application",
  );
}

function assetNotFound(key: string) {
  return $ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND(
    `Cannot find asset ${key} for the single executable application`,
  );
}

/**
 * Node.js returns the bytes inside the executable, which crash the process when they are written to.
 * Here the `ArrayBuffer` is a copy, as from `getAsset()`.
 */
function getRawAsset(key: string): ArrayBuffer {
  validateString(key, "key");
  if (!isSea()) {
    throw notInSea();
  }
  const asset = getAssetInternal(key);
  if (asset === undefined) {
    throw assetNotFound(key);
  }
  return asset;
}

function getAsset(key: string, encoding?: string): ArrayBuffer | string {
  if (encoding !== undefined) {
    validateString(encoding, "encoding");
  }
  const asset = getRawAsset(key);
  if (encoding === undefined) {
    return asset;
  }
  return new TextDecoder(encoding).decode(asset);
}

function getAssetAsBlob(key: string, options?: BlobPropertyBag): Blob {
  validateString(key, "key");
  if (!isSea()) {
    throw notInSea();
  }
  const blob: Blob | undefined = getAssetAsBlobInternal(key);
  if (blob === undefined) {
    throw assetNotFound(key);
  }
  // Node.js copies the asset into `new Blob([asset], options)`. Here the one part is a `Blob`, which
  // shares its bytes, and without a `type` it keeps the type of the file's extension, as in
  // `Bun.embeddedFiles`.
  return options?.type === undefined ? blob : new Blob([blob], options);
}

function getAssetKeys(): string[] {
  if (!isSea()) {
    throw notInSea();
  }
  return getAssetKeysInternal();
}

export default {
  isSea,
  getAsset,
  getRawAsset,
  getAssetAsBlob,
  getAssetKeys,
};
