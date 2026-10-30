// Next supplies this global before importing request async storage in production.
// Supply the same Node primitive for direct route integration tests (no web server).
globalThis.AsyncLocalStorage ??= require("node:async_hooks").AsyncLocalStorage;
