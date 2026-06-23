import express from "express";
import apiRouter from "./api";

const app = express();

app.use(express.json());
app.use("/", apiRouter);

const PORT = 3000;

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});