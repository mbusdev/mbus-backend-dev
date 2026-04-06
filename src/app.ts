import express from "express";

import mbus from "./routes/api"
import ui from "./routes/ui"

const app = express();

app.use(express.json());
app.get('/', (_, res) => {
    res.redirect('/ui/');
});
app.use("/mbus/api/v3", mbus);
app.use("/docs", express.static("docs"));
app.use("/ui/", ui);

const PORT = process.env.PORT || 3000;


app.listen(PORT, () => {
    console.log(`Server (and web ui @ /ui/) running on port ${PORT}`);
});