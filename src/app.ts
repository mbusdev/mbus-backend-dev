import express from "express";

import mbus from "./routes/api";
import v4 from "./routes/v4";
import * as documented from "./routes/documented";

const app = express();

app.use(express.json());
documented.addRouter(documented.globalContext, app, "/mbus/api/v3", mbus);
documented.addRouter(documented.globalContext, app, "/api/v4", v4);
app.use("/docs", express.static("docs"));

const PORT = process.env.PORT || 3000;


app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    if (documented.ENABLED) {
        documented.outputDocsFor(documented.globalContext);
    }
});