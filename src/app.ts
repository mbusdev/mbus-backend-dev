import express from "express";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import mbus from "./routes/api"

const app = express();

// Module-relative so the server works regardless of the launch directory.
const DOCS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../docs");
if (!existsSync(DOCS_DIR)) {
    console.warn(`docs/ not found at ${DOCS_DIR} — /docs will 404 until \`npm run docs\` is run`);
}

app.use(express.json());
app.use("/mbus/api/v3", mbus);
app.use("/docs", express.static(DOCS_DIR));

const PORT = process.env.PORT || 3000;


app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
