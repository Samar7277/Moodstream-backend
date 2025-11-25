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

const dbModule = require("./db");
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

// Rate limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/", apiLimiter);

// 🔥 CORS settings for Localhost + Vercel + Render
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://mood-stream-frontend-5nb3d53yj-samar7277s-projects.vercel.app",
];

app.use(
  cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

app.use(express.json());

// API routes
app.use("/api", uploadRouter);
app.use("/api/tracks", getTracksRoute);
app.use("/api/playlists", playlistRoutes);

// -----------------------------------------
// GOOGLE AUTH ROUTES
// -----------------------------------------
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
    if (!accessToken) return res.status(500).send("Authentication failed");

    const profileResp = await axios.get("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    res.cookie("user", JSON.stringify(profileResp.data), {
      httpOnly: false,
      sameSite: "lax",
    });

    return res.redirect(`${ALLOWED_ORIGINS[0]}/?login=success`);
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

// -----------------------------------------
// TEST ROUTES
// -----------------------------------------
app.get("/test-db", async (req, res) => {
  try {
    const result = await dbModule.query("SELECT NOW()");
    res.json({ connected: true, time: result.rows[0] });
  } catch (err) {
    res.status(500).json({ connected: false, error: err.message });
  }
});

app.get("/test-storage", async (req, res) => {
  try {
    const { data, error } = await supabase.storage.from("Tracks").list();
    if (error) throw error;
    res.json({ connected: true, files: data, sample_image: SAMPLE_IMAGE_PATH });
  } catch (err) {
    res.status(500).json({ connected: false, error: err.message });
  }
});

app.get("/", (req, res) => {
  res.send("Backend running");
});

// ---------- SOCKET.IO ----------
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.set("io", io);

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);
  socket.on("disconnect", (reason) => {
    console.log(`Disconnected: ${socket.id} (${reason})`);
  });
});

// ---------- START SERVER ----------
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🔥 MoodStream Backend running on port ${PORT}`);
});
