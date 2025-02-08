import express, { Request, Response } from "express";
import cors from "cors";
import { MongoClient, Db, Collection } from "mongodb";

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
  lastPingMs: string; // e.g. "42.51"
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
  // @ts-ignore
  app.post("/reportLatency", (req: Request, res: Response) => {
    const startTime = process.hrtime.bigint();

    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    // Immediately send a response
    res.json({ message: "Latency reported. Thanks!" });

    // After response finishes, measure endTime
    res.on("finish", async () => {
      const endTime = process.hrtime.bigint();
      const diffMs = Number(endTime - startTime) / 1_000_000; // nanoseconds -> ms
      const lastPingMs = diffMs.toFixed(2);

      try {
        // Upsert a doc for (userId + region)
        await latencyColl.updateOne(
          { userId, region: SERVER_REGION },
          {
            $set: {
              userId,
              region: SERVER_REGION,
              lastPingMs,
              updatedAt: new Date(),
            },
          },
          { upsert: true }
        );
        console.log(
          `User ${userId} ping => region:${SERVER_REGION}, RTT = ${lastPingMs} ms`
        );
      } catch (err) {
        console.error("MongoDB update error:", err);
      }
    });
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
        const aPing = parseFloat(a.lastPingMs);
        const bPing = parseFloat(b.lastPingMs);
        return aPing - bPing;
      });

      // The first record in sorted order has the lowest latency
      const best = records[0];
      const bestMs = parseFloat(best.lastPingMs);

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
