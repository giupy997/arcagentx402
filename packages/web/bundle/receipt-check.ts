// What cra-agent.tech/verify runs in the visitor's browser: the router's own receipt checks, bundled by build.mjs.
// The logic and its tests live in packages/router; this file only says what goes into the bundle.
export { findSignedReceipt, inspectReceipt } from "../../router/src/receipt.js";
