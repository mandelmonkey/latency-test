import express, { Request, Response } from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import crypto from "crypto";
import cors from "cors";
import { MongoClient, Db, Collection } from "mongodb";

// ---------------------
// CONFIG & ENVIRONMENT
// ---------------------
const SERVER_REGION = process.env.SERVER_REGION || "UNKNOWN";
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const DB_NAME = "locationDb";
const COLLECTION_NAME = "userServerLatency";
const DEFAULT_TOTAL_ITERATIONS = 5; // The server controls the number of RTT tests

// ---------------------
// Interfaces
// ---------------------
interface UserLatencyDoc {
  userId: string;
  region: string;
  ipAddress?: string;
  lastPingMs: number;
  updatedAt: Date;
}

interface TestState {
  userId: string;
  iteration: number;
  totalIterations: number;
  sumOfRTTs: number;
  startTracking: Date;
  ipAddress?: string;
}

// ---------------------
// MongoDB Globals
// ---------------------
let mongoClient: MongoClient;
let db: Db;
let latencyColl: Collection<UserLatencyDoc>;

// ---------------------
// Express & Socket.io Setup
// ---------------------
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: "*",
  },
});

// ---------------------
// In-Memory Test State
// ---------------------
const testStateMap: Map<string, TestState> = new Map();

// Remove stale test states (older than EXPIRATION_MS milliseconds)
const EXPIRATION_MS = 60_000; // 1 minute
function cleanupTestState(): void {
  const now = Date.now();
  for (const [token, state] of testStateMap.entries()) {
    if (now - state.startTracking.getTime() > EXPIRATION_MS) {
      testStateMap.delete(token);
    }
  }
}
setInterval(cleanupTestState, 30000); // run every 30 seconds

// ---------------------
// Socket.io Event Handling
// ---------------------
io.on("connection", (socket) => {
  console.log("New client connected: " + socket.id);

  // Client initiates a test session.
  socket.on("startTest", (data: { userId: string }) => {
    const { userId } = data;
    if (!userId) {
      socket.emit("error", { message: "Missing userId" });
      return;
    }
    // Create a new test session
    const token: string = crypto.randomBytes(8).toString("hex");
    const startTracking = new Date();
    const state: TestState = {
      userId,
      iteration: 0,
      totalIterations: DEFAULT_TOTAL_ITERATIONS,
      sumOfRTTs: 0,
      startTracking,
    };
    testStateMap.set(token, state);
    console.log(
      `startTest: userId=${userId}, totalIterations=${DEFAULT_TOTAL_ITERATIONS}, token=${token}`
    );
    // Send the token (and total iterations) back to the client.
    socket.emit("token", { token, totalIterations: DEFAULT_TOTAL_ITERATIONS });
  });

  // Client echoes the token to mark an iteration.
  socket.on("echoToken", (data: { token: string }) => {
    const { token } = data;
    if (!token || !testStateMap.has(token)) {
      socket.emit("error", { message: "Token not found or expired" });
      return;
    }
    const state = testStateMap.get(token)!;
    const now = new Date();
    const rtt = now.getTime() - state.startTracking.getTime();
    state.sumOfRTTs += rtt;
    state.iteration += 1;
    console.log(
      `echoToken: Socket ${socket.id}: Iteration ${state.iteration}/${state.totalIterations} for user ${state.userId}, RTT=${rtt}ms`
    );

    if (state.iteration >= state.totalIterations) {
      const avgRtt = Math.round(state.sumOfRTTs / state.totalIterations);
      // Update MongoDB (non-blocking)
      latencyColl
        .updateOne(
          { userId: state.userId, region: SERVER_REGION },
          {
            $set: {
              userId: state.userId,
              region: SERVER_REGION,
              lastPingMs: avgRtt,
              updatedAt: new Date(),
            },
          },
          { upsert: true }
        )
        .catch((err) => console.error("MongoDB update error:", err));
      testStateMap.delete(token);
      socket.emit("testComplete", {
        avgRttMs: avgRtt,
        totalIterations: state.totalIterations,
      });
    } else {
      // Not done yet: reset startTracking for the next iteration.
      state.startTracking = new Date();
      socket.emit("iterationComplete", {
        iterationSoFar: state.iteration,
        totalIterations: state.totalIterations,
      });
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected: " + socket.id);
  });
});

// ---------------------
// Serve a Client Web Page
// ---------------------
app.get("/", (req: Request, res: Response) => {
  // This HTML page includes client-side Socket.io code to run the test.
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>WebSocket Multi-Region RTT Test</title>
</head>
<body>
  <h1>WebSocket Multi-Region RTT Test</h1>
  <p>
    User ID: <input id="userId" value="testUser123" />
    <button id="startTestBtn">Start Test</button>
  </p>
  <pre id="logOutput" style="background: #eee; padding: 1em;"></pre>
  
  <!-- Include the Socket.io client library -->
  <script src="/socket.io/socket.io.js"></script>
  <script>
    const logOutput = document.getElementById("logOutput");
    const startBtn = document.getElementById("startTestBtn");
    const userIdInput = document.getElementById("userId");

    // Define the remote endpoints to test.
    // These are the fully qualified URLs for your US and EU servers.
    const endpoints = [
      { name: "US", url: "https://latency-test-us-dc1c0df1e579.herokuapp.com" },
      { name: "EU", url: "https://latency-test-eu-6615850a4a65.herokuapp.com" }
    ];

    // Run a test for one endpoint using WebSockets.
    function runTestForEndpoint(endpoint, userId) {
    console.log("endpoint",endpoint);
      return new Promise((resolve, reject) => {
        const socket = io(endpoint.url);
        let currentToken = null;
        socket.on("connect", () => {
          logOutput.textContent += endpoint.name + ": Connected\\n";
          socket.emit("startTest", { userId });
        });
        socket.on("token", (data) => {
          currentToken = data.token;
          logOutput.textContent += endpoint.name + ": Received token: " + currentToken + ", totalIterations: " + data.totalIterations + "\\n";
          // Immediately echo the token for the first iteration.
          socket.emit("echoToken", { token: currentToken });
        });
        socket.on("iterationComplete", (data) => {
          logOutput.textContent += endpoint.name + ": Iteration complete (" + data.iterationSoFar + "/" + data.totalIterations + ")\\n";
          // Send the echoToken event again for the next iteration.
          socket.emit("echoToken", { token: currentToken });
        });
        socket.on("testComplete", (data) => {
          logOutput.textContent += endpoint.name + ": Test complete! Average RTT: " + data.avgRttMs + " ms over " + data.totalIterations + " iterations\\n";
          socket.disconnect();
          resolve({ name: endpoint.name, avgRttMs: data.avgRttMs });
        });
        socket.on("error", (err) => {
          logOutput.textContent += endpoint.name + ": Error: " + err.message + "\\n";
          socket.disconnect();
          reject(err);
        });
      });
    }

    startBtn.addEventListener("click", async () => {
      logOutput.textContent = "";
      const userId = userIdInput.value.trim();
      if (!userId) {
        alert("Please enter a userId");
        return;
      }
      // Run tests concurrently for all endpoints.
      const tests = endpoints.map(ep => runTestForEndpoint(ep, userId));
      try {
        const results = await Promise.all(tests);
        logOutput.textContent += "\\nFinal Results:\\n" + JSON.stringify(results, null, 2) + "\\n";
      } catch (err) {
        logOutput.textContent += "One or more tests failed.\\n";
      }
    });
  </script>
</body>
</html>
  `);
});

// ---------------------
// Startup: Connect to MongoDB and Start the Server
// ---------------------
async function startServer() {
  try {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    console.log("Connected to MongoDB:", MONGODB_URI);
    db = mongoClient.db(DB_NAME);
    latencyColl = db.collection<UserLatencyDoc>(COLLECTION_NAME);

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}. Region = ${SERVER_REGION}`);
    });
  } catch (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
}

startServer();
