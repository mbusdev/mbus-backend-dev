import express from "express";
import { connectToDatabase } from "./db/connection.js";
import mbus from "./routes/api.js";
import users from "./routes/users.js";

const app = express();

app.use(express.json());
app.use("/mbus/api/v3", mbus);
app.use("/mbus/api/v3/account", users);
app.use("/docs", express.static("docs"));

const PORT = process.env.PORT || 3000;

connectToDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
});