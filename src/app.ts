import express from "express";

import mbus from "./routes/api"

const app = express();

app.use(express.json());
app.use("/mbus/api/v3", mbus);
app.use("/docs", express.static("docs"));

const PORT = process.env.PORT || 3000;


app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});