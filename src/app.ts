import express from "express";

import mbus from "./routes/api"
import ui from "./routes/ui"

const app = express();

app.use(express.json());
app.use("/mbus/api/v3", mbus);
app.use("/docs", express.static("docs"));
app.use("/ui", ui);

const PORT = process.env.PORT || 3000;


app.listen(PORT, () => {
    console.log(`Server (and web ui @ /ui) running on port ${PORT}`);
});