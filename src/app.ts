import express from "express";

import mbus from "./routes/api"
import { addRouter, dumpReflectionInfo, reflection } from "./routes/documented";

const app = express();

app.use(express.json());
addRouter(app, "/mbus/api/v3", mbus);
app.use("/docs", express.static("docs"));

const PORT = process.env.PORT || 3000;


app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    if (reflection)
        dumpReflectionInfo();
});