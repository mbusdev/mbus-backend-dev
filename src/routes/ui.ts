import express from 'express';
import * as fs from 'fs';
import dotenv from 'dotenv';
import { exit } from 'process';

dotenv.config();

const router = express.Router();
const mapsKey = process.env.MAPS_KEY;
if (mapsKey == undefined) {
    console.error("MAPS_KEY not set!");
    exit(1);
}

router.get('/', (req, res) => {
    let contents = fs.readFileSync('src/ui/index.html').toString();
    contents = contents.replace("@@@KEY@@@", mapsKey);
    res.send(contents);
});

export default router;