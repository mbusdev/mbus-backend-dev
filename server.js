import express from "express";
import multer from "multer";
import unzipper from "unzipper";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { findPath } from "./src/assets/indoor/pathfinder.js";

let currentGraph = null;

const app = express();

const uploadDir = path.join(
  process.cwd(),
  "src",
  "assets",
  "indoor",
  "uploads"
);

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// store docs
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.originalname.endsWith(".zip")) {
      return cb(new Error("Only .zip allowed"));
    }
    cb(null, true);
  }
});


function readGraph(unzipDir, manifest) {
  const buildingFolder = fs.readdirSync(unzipDir)[0];

  const graphs = [];

  for (const floor of manifest.floors) {
    const graphPath = path.join(
      unzipDir,
      buildingFolder,
      floor.graphFile
    );

    const content = fs.readFileSync(graphPath, "utf-8");
    const graph = JSON.parse(content);

    graphs.push(graph);
  }

  return graphs;
}

function readManifest(unzipDir) {
  // 找到解压后的第一层文件夹（比如 building-package）
  const buildingFolder = fs.readdirSync(unzipDir)[0];

  const manifestPath = path.join(
    unzipDir,
    buildingFolder,
    "manifest.json"
  );

  const content = fs.readFileSync(manifestPath, "utf-8");
  return JSON.parse(content);
}

async function unzipFile(zipPath) {
  const outputDir = zipPath + "_unzipped";

  // 如果已经存在（避免重复解压报错）
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  await fs.createReadStream(zipPath)
    .pipe(unzipper.Extract({ path: outputDir }))
    .promise();

  return outputDir;
}


// upload port
app.post("/upload-building", upload.single("file"), async (req, res) => {
  try {
    console.log("VALIDATION START");

    const zipPath = req.file.path;

    // 1. 解压
    const unzipDir = await unzipFile(zipPath);

    // 2. 读 manifest
    const manifest = readManifest(unzipDir);

    // 3. 读 graph
    const graphs = readGraph(unzipDir, manifest);

    console.log("nodes number:", graphs[0].nodes.length);
    console.log("edges number:", graphs[0].edges.length);

    res.json({
      message: "graph loaded",
      nodes: graphs[0].nodes.length,
      edges: graphs[0].edges.length
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});