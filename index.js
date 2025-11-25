require("dotenv").config();


const express = require("express");
const axios = require("axios");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");


const SAMPLE_IMAGE_PATH = "/mnt/data/Screenshot 2025-11-25 at 10.04.22 PM.png";

const dbModule = require("./db"); // could export pool OR { pool, query, shutdownPool }
const supabase = require("./supabaseClient");

const uploadRouter = require("./routes/upload");
const getTracksRoute = require("./routes/getTracks");
const playlistRoutes = require("./routes/playlists");

const app = express();

// Basic security + logging
app.use(helmet());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// Body parsing
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());

// Rate limiter (tunable)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // limit each IP to 300 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/", apiLimiter);

// CORS: allow frontend origin, allow credentials and Authorization header
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

// Mount API routes (keep uploadRouter mounted at /api so it serves /api/upload-track)
app.use("/api", uploadRouter);

// If getTracksRoute is a router exposing '/' for list, mount at /api/tracks
app.use("/api/tracks", getTracksRoute);

// Playlist routes mounted at /api/playlists
app.use("/api/playlists", playlistRoutes);

// -------------------------------------------------------
// Simple auth / debug endpoints (Google OAuth flow preserved)
// -------------------------------------------------------
app.get("/auth/google", (req, res) => {
  const redirect =
    `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${process.env.GOOGLE_CLIENT_ID}` +
    `&redirect_uri=${process.env.GOOGLE_REDIRECT_URI}` +
    `&response_type=code` +
    `&scope=openid%20email%20profile`;

  res.redirect(redirect);
});

app.get("/auth/google/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code parameter");

  try {
    const tokenResp = await axios.post(
      "https://oauth2.googleapis.com/token",
      new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code",
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const accessToken = tokenResp.data.access_token;
    if (!accessToken) return res.status(500).send("Authentication failed (token missing)");

    const profileResp = await axios.get("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    res.cookie("user", JSON.stringify(profileResp.data), {
      httpOnly: false,
      sameSite: "lax",
    });

    return res.redirect(`${FRONTEND_URL}/?login=success`);
  } catch (err) {
    console.error("GOOGLE CALLBACK ERROR:", err?.response?.data || err.message);
    return res.status(500).send("Authentication failed");
  }
});

app.get("/auth/me", (req, res) => {
  try {
    if (!req.cookies?.user) return res.json({ user: null });
    return res.json({ user: JSON.parse(req.cookies.user) });
  } catch (err) {
    return res.json({ user: null });
  }
});

app.post("/auth/logout", (req, res) => {
  res.clearCookie("user");
  res.json({ message: "Logged out" });
});

// Helper: unified DB query function (handles both export shapes)
async function dbQuery(text, params) {
  // If your db.js exported a 'query' function, use it.
  if (typeof dbModule.query === "function") {
    return dbModule.query(text, params);
  }
  // otherwise assume it exported a Pool instance
  const pool = dbModule.pool || dbModule; // dbModule could itself be a Pool
  return pool.query(text, params);
}

// Helper: graceful shutdown for DB
async function shutdownDB() {
  try {
    if (typeof dbModule.shutdownPool === "function") {
      await dbModule.shutdownPool();
      console.log("[DB] shutdown via shutdownPool() complete");
      return;
    }
    // if pool object with end()
    const pool = dbModule.pool || dbModule;
    if (pool && typeof pool.end === "function") {
      await pool.end();
      console.log("[DB] pool.end() complete");
    }
  } catch (err) {
    console.warn("[DB] error during shutdown:", err);
  }
}

// Test DB connectivity
app.get("/test-db", async (req, res) => {
  try {
    const result = await dbQuery("SELECT NOW()");
    // result.rows[0] or result.rows depending on shape
    res.json({ connected: true, time: result.rows ? result.rows[0] : result });
  } catch (err) {
    res.status(500).json({ connected: false, error: err.message });
  }
});

// Test Supabase Storage and return local sample path in response
app.get("/test-storage", async (req, res) => {
  try {
    const { data, error } = await supabase.storage.from("Tracks").list();
    if (error) throw error;
    res.json({ connected: true, files: data, sample_image: SAMPLE_IMAGE_PATH });
  } catch (err) {
    res.status(500).json({ connected: false, error: err.message, sample_image: SAMPLE_IMAGE_PATH });
  }
});

app.get("/", (req, res) => {
  res.send("Backend running");
});

// -------------------------------------------------------
// Debug endpoints for local uploaded file
// - GET /debug/local-image         => returns JSON { url: SAMPLE_IMAGE_PATH }
// - GET /debug/local-image/file    => serves the file directly (use in browser)
// -------------------------------------------------------
app.get("/debug/local-image", (req, res) => {
  // Return the local path as the "url" value per your request.
  res.json({ url: SAMPLE_IMAGE_PATH });
});

app.get("/debug/local-image/file", (req, res) => {
  // If the file exists, serve it; otherwise return 404
  if (fs.existsSync(SAMPLE_IMAGE_PATH)) {
    return res.sendFile(path.resolve(SAMPLE_IMAGE_PATH));
  }
  return res.status(404).send("Local debug image not found");
});

// ---------- Socket.IO setup & start server ----------
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// expose io to routes so they can do: const io = req.app.get('io'); io.emit(...)
app.set("io", io);

// Basic socket events (optional) — logs connections and disconnections
io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);
  socket.on("disconnect", (reason) => {
    console.log(`Socket disconnected: ${socket.id} (${reason})`);
  });
});

// Global error handler (simple)
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({
    error: err.message || "Internal Server Error",
  });
});

// Start
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🔥 MoodStream Backend (with sockets) running on http://localhost:${PORT}`);
});

// ---------- Graceful shutdown ----------
let shuttingDown = false;
async function gracefulShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] Received ${reason} — closing server, sockets, DB...`);

  try {
    // Stop accepting new connections
    server.close((err) => {
      if (err) console.error("[shutdown] server.close error:", err);
    });

    // Close socket.io (disconnect clients)
    try {
      await io.close();
      console.log("[shutdown] socket.io closed");
    } catch (err) {
      console.warn("[shutdown] socket.io close error:", err);
    }

    // Shutdown DB pool cleanly
    await shutdownDB();
  } catch (err) {
    console.error("[shutdown] error during graceful shutdown:", err);
  } finally {
    console.log("[shutdown] exiting process");
    // small delay to allow logs to flush
    setTimeout(() => process.exit(0), 250);
  }
}

// Global handlers that attempt graceful shutdown
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGQUIT", () => gracefulShutdown("SIGQUIT"));

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled rejection, reason:", reason);
  // Try graceful shutdown; leave exit decision to shutdown
  gracefulShutdown("unhandledRejection");
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception, shutting down:", err);
  // try to shutdown cleanly before exit
  gracefulShutdown("uncaughtException");
});
