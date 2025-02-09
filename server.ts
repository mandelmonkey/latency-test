import express, { Request, Response } from "express";
import cors from "cors";
import { MongoClient, Db, Collection } from "mongodb";
import crypto from "crypto";
//////////////////////////////////////////////////////////
//  CONFIGURATIONS & ENV
//////////////////////////////////////////////////////////

// e.g. SERVER_REGION=US or SERVER_REGION=JP
const SERVER_REGION = process.env.SERVER_REGION || "UNKNOWN";

// A threshold to decide if user is "close" to the server
// Adjust as needed; e.g., US/JP threshold might differ
const LATENCY_CLOSE_THRESHOLD_MS = 150;

// MongoDB
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const DB_NAME = "locationDb";
const COLLECTION_NAME = "userServerLatency";

// Interfaces for our stored data
interface UserLatencyDoc {
  userId: string; // Unique user identifier
  region: string; // Which server region measured the latency
  lastPingMs: number; // e.g. "42.51"
  updatedAt: Date;
}

//////////////////////////////////////////////////////////
//  GLOBALS
//////////////////////////////////////////////////////////

let mongoClient: MongoClient;
let db: Db;
let latencyColl: Collection<UserLatencyDoc>;

//////////////////////////////////////////////////////////
//  EXPRESS APP
//////////////////////////////////////////////////////////
function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cors());

  /**
   * POST /reportLatency
   *  - The client sends { userId: string }
   *  - The server measures approx. RTT on the server side
   *  - Stores { userId, region, lastPingMs, updatedAt } in Mongo
   */

  const tokenMap = new Map<string, Date>();

  // @ts-ignore
  app.post("/reportLatency", (req, res) => {
    const { userId, token } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    // 1) First request: no token -> generate one
    if (!token) {
      const randomToken = crypto.randomBytes(8).toString("hex");
      const startTracking = new Date();

      // Store in memory, not in DB
      tokenMap.set(randomToken, startTracking);

      return res.json({ token: randomToken });
    }

    // 2) Second request: token present -> measure RTT
    const startTracking = tokenMap.get(token);
    if (!startTracking) {
      return res.status(404).json({ error: "Token not found" });
    }

    const rttMs = new Date().getTime() - startTracking.getTime();

    // Remove the token from the map (no replay)
    tokenMap.delete(token);

    // (Optional) Write to DB now, but your RTT is already measured
    // so DB overhead won't affect the measured time:
    latencyColl
      .updateOne(
        { userId, region: SERVER_REGION },
        {
          $set: {
            userId,
            region: SERVER_REGION,
            lastPingMs: rttMs,
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      )
      .catch((err) => console.error("DB error:", err));

    // Return the computed RTT
    return res.json({ message: "RTT measured", rttMs });
  });

  /**
   * GET /getLatency/:userId
   * - Returns all region-latency docs for this user
   */
  // @ts-ignore
  app.get("/getLatency/:userId", async (req: Request, res: Response) => {
    const { userId } = req.params;
    try {
      const records = await latencyColl
        .find({ userId })
        .sort({ updatedAt: -1 })
        .toArray();

      if (records.length === 0) {
        return res.json({
          userId,
          msg: "No latency data for this user",
          records: [],
        });
      }
      res.json({
        userId,
        records,
      });
    } catch (err) {
      console.error("MongoDB find error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /closestServer/:userId
   *  - Looks at all region-latency docs for this user
   *  - Finds the server with the lowest latency
   *  - If the best latency is still too high, we say "user not close to either"
   */
  // @ts-ignore
  app.get("/closestServer/:userId", async (req: Request, res: Response) => {
    const { userId } = req.params;
    try {
      const records = await latencyColl.find({ userId }).toArray();
      if (records.length === 0) {
        return res.json({
          userId,
          closest: null,
          msg: "No data from any server for this user.",
        });
      }

      // Sort by ascending lastPingMs
      records.sort((a, b) => {
        const aPing = a.lastPingMs;
        const bPing = b.lastPingMs;
        return aPing - bPing;
      });

      // The first record in sorted order has the lowest latency
      const best = records[0];
      const bestMs = best.lastPingMs;

      if (bestMs > LATENCY_CLOSE_THRESHOLD_MS) {
        return res.json({
          userId,
          closest: null,
          msg: `User's best latency is ${bestMs} ms, above threshold. Not close to any server.`,
        });
      }

      // If it's below threshold, we consider that region "closest"
      res.json({
        userId,
        closest: {
          region: best.region,
          lastPingMs: best.lastPingMs,
          updatedAt: best.updatedAt,
        },
        msg: `Closest server region is ${best.region} with ${best.lastPingMs} ms RTT`,
      });
    } catch (err) {
      console.error("MongoDB find error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return app;
}

//////////////////////////////////////////////////////////
//  STARTUP
//////////////////////////////////////////////////////////
async function startServer() {
  try {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    console.log("Connected to MongoDB:", MONGODB_URI);

    db = mongoClient.db(DB_NAME);
    latencyColl = db.collection<UserLatencyDoc>(COLLECTION_NAME);

    const app = createApp();
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}. Region = ${SERVER_REGION}`);
    });
  } catch (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
}

// Entry point
startServer();
