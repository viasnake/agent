import { serveWorker } from "../src/execution/worker.js";
// Only a test helper may run the protocol without the provisioned guest UID.
await serveWorker({ root: process.argv[2]!, production: false });
