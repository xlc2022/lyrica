// Replaces the deprecated node-domexception package (package.json,
// "overrides"), which fetch-blob still imports. Node 17 and later have
// DOMException built in, which is all that package handed back.
module.exports = globalThis.DOMException;
