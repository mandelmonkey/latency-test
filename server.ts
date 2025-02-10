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
const LATENCY_CLOSE_THRESHOLD_MS = 150;

// MongoDB
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const DB_NAME = "locationDb";
const COLLECTION_NAME = "userServerLatency";

// The server-defined number of tests (iterations)
const DEFAULT_TOTAL_ITERATIONS = 5;

//////////////////////////////////////////////////////////
//  INTERFACES
//////////////////////////////////////////////////////////

interface UserLatencyDoc {
  userId: string; // Unique user identifier
  ipAddress: string | undefined;
  region: string; // Which server region measured the latency
  lastPingMs: number; // e.g. 42
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
   * POST /clientLatency
   *
   * Endpoint to receive client-to-server latency results.
   * The client sends the average latency after completing its tests.
   */
  app.post("/clientLatency", async (req: Request, res: Response) => {
    try {
      const { userId, avgLatencyMs } = req.body;
      const ipAddress = req.header("x-forwarded-for");

      if (!userId || avgLatencyMs === undefined) {
        return res
          .status(400)
          .json({ error: "Missing userId or avgLatencyMs" });
      }

      // Store the latency result in the database
      await latencyColl.updateOne(
        { userId, region: SERVER_REGION },
        {
          $set: {
            userId,
            ipAddress,
            region: SERVER_REGION,
            lastPingMs: avgLatencyMs,
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      );

      console.log(
        `Client-to-server latency recorded: userId=${userId}, avgLatencyMs=${avgLatencyMs}ms`
      );

      res.json({ message: "Client latency recorded successfully." });
    } catch (err) {
      console.error("Error in /clientLatency route:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /clientLatencyTestConfig
   *
   * Returns the configuration for the client-to-server latency test.
   */
  app.get("/clientLatencyTestConfig", (req, res) => {
    res.json({
      totalIterations: DEFAULT_TOTAL_ITERATIONS,
      region: SERVER_REGION,
    });
  });

  return app;
}

//////////////////////////////////////////////////////////
//  STARTUP
//////////////////////////////////////////////////////////
async function startServer() {
  try {
    // Connect to MongoDB
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    console.log("Connected to MongoDB:", MONGODB_URI);

    db = mongoClient.db(DB_NAME);
    latencyColl = db.collection<UserLatencyDoc>(COLLECTION_NAME);

    // Create and start the Express app
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
