// A compiled program is a single executable application, and a file that plain Bun runs is not: isSea() of node:sea says which one this is.
const sea = require("node:sea");
console.log(Object.keys(sea).sort().join(), sea.isSea());

/* Output:
getAsset,getAssetAsBlob,getAssetKeys,getRawAsset,isSea true
*/
