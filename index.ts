// Pi loads src/extension.ts through package.json `pi.extensions`. This
// re-export keeps direct loads of the old root entry working for one release.
export { default } from "./src/extension.ts";
