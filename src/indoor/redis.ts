import { createClient } from "redis";

const redisClient = createClient({
  url: "redis://127.0.0.1:6379"
});

redisClient.on("error", (err) => {
  console.error("[Redis] Error:", err);
});

let connected = false;

export async function getRedis() {
  if (!connected) {
    await redisClient.connect();
    connected = true;
    console.log("[Redis] Connected");
  }
  return redisClient;
}