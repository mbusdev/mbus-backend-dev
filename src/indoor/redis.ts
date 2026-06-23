import { createClient } from "redis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

const redisClient = createClient({
  url: REDIS_URL
});

redisClient.on("error", (err) => {
  console.error("[Redis] Error:", err);
});

let connected = false;

export async function getRedis() {
  if (!connected) {
    await redisClient.connect();
    connected = true;
    console.log(`[Redis] Connected: ${REDIS_URL}`);
  }

  return redisClient;
}