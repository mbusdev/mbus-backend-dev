import express from "express";

import mbus from "./routes/api"
import * as documented from "./routes/documented";

const app = express();

app.use(express.json());
documented.addRouter(documented.globalContext, app, "/mbus/api/v3", mbus);
app.use("/docs", express.static("docs"));

const PORT = process.env.PORT || 3000;


app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    if (documented.ENABLED) {
        documented.outputDocsFor(documented.globalContext);
    }
});