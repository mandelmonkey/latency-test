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

/**
 * In-memory structure to track multiple RTT tests for one token.
 * Example flow:
 *  - iteration=0
 *  - totalIterations=5 (server-defined)
 *  - sumOfRTTs=0
 *  - startTracking=Date (for current iteration)
 */
interface TestState {
  userId: string;
  ipAddress: string | undefined;
  iteration: number;
  totalIterations: number;
  sumOfRTTs: number;
  startTracking: Date;
}

//////////////////////////////////////////////////////////
//  GLOBALS
//////////////////////////////////////////////////////////
let mongoClient: MongoClient;
let db: Db;
let latencyColl: Collection<UserLatencyDoc>;

// In-memory token map: token => TestState
const tokenMap = new Map<string, TestState>();

// Clean up tokens that are too old, to prevent spamming
const EXPIRATION_MS = 60_000; // 1 minute expiration
function cleanupTokenMap() {
  const now = Date.now();
  for (const [token, state] of tokenMap.entries()) {
    if (now - state.startTracking.getTime() > EXPIRATION_MS) {
      tokenMap.delete(token);
    }
  }
}
// Run cleanup every 30 seconds
setInterval(cleanupTokenMap, 30000);

//////////////////////////////////////////////////////////
//  EXPRESS APP
//////////////////////////////////////////////////////////
function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cors());

  app.get("/", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Multi-Region RTT Test</title>
</head>
<body>
  <h1>Multi-Region RTT Test</h1>
  <p>
    Enter a userId: <input id="userId" value="testUser123" />
    <button id="startTestBtn">Start Test</button>
  </p>
  <pre id="logOutput" style="background:#eee; padding:1em;"></pre>
  
  <script>
    // List of remote endpoints to test
    const endpoints = [
      { name: "US", url: "https://latency-test-us-dc1c0df1e579.herokuapp.com" },
      { name: "EU", url: "https://latency-test-eu-6615850a4a65.herokuapp.com" }
    ];

    const logArea = document.getElementById("logOutput");
    const startBtn = document.getElementById("startTestBtn");
    const userIdInput = document.getElementById("userId");

    // Function to run the multi-iteration test for a given endpoint.
    async function runTestForEndpoint(endpoint, userId) {
      logArea.textContent += "Starting test for " + endpoint.name + " (" + endpoint.url + ")\\n";
      try {
        // First call: no token provided
        let resp = await fetch(endpoint.url + "/reportLatency", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId })
        });
        let data = await resp.json();
        
        if (!data.token) {
          logArea.textContent += "Error: No token received from " + endpoint.name + ": " + JSON.stringify(data) + "\\n";
          return;
        }
        
        const token = data.token;
        const totalIterations = data.totalIterations;
        logArea.textContent += endpoint.name + ": Received token: " + token + ". Total iterations: " + totalIterations + "\\n";
        
        let done = false;
        while (!done) {
          resp = await fetch(endpoint.url + "/reportLatency", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId, token })
          });
          data = await resp.json();
          
          if (data.avgRttMs !== undefined) {
            logArea.textContent += endpoint.name + ": All tests done. Average RTT = " + data.avgRttMs + " ms\\n";
            done = true;
            return { name: endpoint.name, avgRttMs: data.avgRttMs };
          } else {
            logArea.textContent += endpoint.name + ": Iteration complete (" + data.iterationSoFar + " / " + data.totalIterations + ")\\n";
          }
        }
      } catch (err) {
        logArea.textContent += endpoint.name + ": Error: " + err + "\\n";
      }
    }

    startBtn.addEventListener("click", async () => {
      logArea.textContent = "";
      const userId = userIdInput.value.trim();
      if (!userId) {
        alert("Please enter a userId");
        return;
      }
      // Run tests concurrently for both endpoints
      const results = await Promise.all(endpoints.map(ep => runTestForEndpoint(ep, userId)));
      logArea.textContent += "\\nTest results:\\n" + JSON.stringify(results, null, 2) + "\\n";
    });
  </script>
</body>
</html>
    `);
  });

  /**
   * POST /reportLatency
   *
   * 1) First call (no token) => server generates a token, sets iteration=0,
   *    totalIterations = DEFAULT_TOTAL_ITERATIONS, sumOfRTTs=0, and returns { token, totalIterations }
   *
   * 2) Next calls => { userId, token }
   *    - Server measures RTT = now - startTracking
   *    - iteration++
   *    - sumOfRTTs += RTT
   *    - if iteration < totalIterations => reset startTracking=now, return { iterationSoFar }
   *    - if iteration === totalIterations => compute avg, store in DB, remove token from map, return { avgRttMs }
   */
  // @ts-ignore
  app.post("/reportLatency", async (req: Request, res: Response) => {
    try {
      const { userId, token } = req.body;
      const ipAddress = req.header("x-forwarded-for");

      if (!userId) {
        return res.status(400).json({ error: "Missing userId" });
      }

      // 1) If no token, it's the first call in the sequence
      if (!token) {
        // Generate random token
        const randomToken = crypto.randomBytes(8).toString("hex");
        const startTracking = new Date();

        // Create the initial state
        const newState: TestState = {
          userId,
          ipAddress,
          iteration: 0,
          totalIterations: DEFAULT_TOTAL_ITERATIONS,
          sumOfRTTs: 0,
          startTracking,
        };
        tokenMap.set(randomToken, newState);

        console.log(
          `First call: userId=${userId}, totalTests=${DEFAULT_TOTAL_ITERATIONS}, token=${randomToken}`
        );

        return res.json({
          token: randomToken,
          totalIterations: DEFAULT_TOTAL_ITERATIONS,
          message: `Begin RTT test. Repeat calls until all ${DEFAULT_TOTAL_ITERATIONS} iterations complete.`,
        });
      }

      // 2) If token is present, we're continuing the handshake
      const state = tokenMap.get(token);
      if (!state) {
        return res.status(404).json({ error: "Token not found or expired." });
      }

      // Calculate this iteration's RTT
      const now = new Date();
      const rttMs = now.getTime() - state.startTracking.getTime();

      state.sumOfRTTs += rttMs;
      state.iteration += 1;

      console.log(
        `Iteration #${state.iteration} of ${state.totalIterations} for user=${state.userId}. RTT=${rttMs}ms`
      );

      if (state.iteration >= state.totalIterations) {
        // We are done. Compute average, store in DB, remove token.
        const avgRttMs = Math.round(state.sumOfRTTs / state.totalIterations);

        // Store final in Mongo
        await latencyColl.updateOne(
          { userId: state.userId, region: SERVER_REGION },
          {
            $set: {
              userId: state.userId,
              ipAddress: state.ipAddress,
              region: SERVER_REGION,
              lastPingMs: avgRttMs,
              updatedAt: new Date(),
            },
          },
          { upsert: true }
        );

        tokenMap.delete(token);

        console.log(
          `Completed all ${state.totalIterations} tests. avgRttMs=${avgRttMs} for user=${state.userId}.`
        );

        return res.json({
          message: "All tests completed",
          avgRttMs,
          totalIterations: state.totalIterations,
        });
      } else {
        // Not done yet: prepare for next iteration
        state.startTracking = now;
        return res.json({
          message: "Test iteration complete. Continue calling until done.",
          iterationSoFar: state.iteration,
          totalIterations: state.totalIterations,
        });
      }
    } catch (err) {
      console.error("Error in /reportLatency route:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
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
      return res.json({
        userId,
        records,
      });
    } catch (err) {
      console.error("MongoDB find error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  /**
   * GET /closestServer/:userId
   *  - Looks at all region-latency docs for this user
   *  - Finds the server with the lowest latency
   *  - If the best latency is still too high, we say "user not close to any server"
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
      records.sort((a, b) => a.lastPingMs - b.lastPingMs);

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
      return res.json({
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
      return res.status(500).json({ error: "Internal server error" });
    }
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
