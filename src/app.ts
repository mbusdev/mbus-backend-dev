import express from "express";

import "@/services/observability";
import mbus from "./routes/api"
import auth from "./routes/auth";
import floorplans from "./routes/floorplans";

const app = express();

app.use(express.json());
app.use("/mbus/api/v3/auth", auth);
app.use("/mbus/api/v3/floorplans", floorplans);
app.use("/mbus/api/v3", mbus);
app.use("/docs", express.static("docs"));

const PORT = process.env.PORT || 3000;


app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
