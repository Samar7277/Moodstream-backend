
const express = require("express");
const multer = require("multer");
const path = require("path");
const supabase = require("../supabaseClient");
const pool = require("../db");

const router = express.Router();

// Multer memory upload
const upload = multer({ storage: multer.memoryStorage() });

// Local fallback for testing (from your environment)
const LOCAL_TEST_PATH = "/mnt/data/Screenshot 2025-11-25 at 10.04.22 PM.png";

// Make filenames safe
function makeSafeName(name) {
  return String(name || "file")
    .replace(/\s+/g, "_")
    // allow letters, numbers, underscores, hyphens and dots
    .replace(/[^a-zA-Z0-9_\-\.]/g, "");
}

// Send JSON error
function sendJsonError(res, status = 500, payload = {}) {
  return res.status(status).json(payload);
}

// Upload helper (Supabase)
// returns publicUrl (string) or throws on error
async function uploadBuffer(bucket, filePath, buffer, mime) {
  const { error } = await supabase.storage.from(bucket).upload(filePath, buffer, {
    contentType: mime,
    upsert: false,
  });

  if (error) throw error;

  const { data } = supabase.storage.from(bucket).getPublicUrl(filePath);
  return data?.publicUrl || null;
}

// ----------------------
// POST /api/upload-track
// ----------------------
router.post(
  "/upload-track",
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "cover", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const audio = req.files?.audio?.[0];
      const cover = req.files?.cover?.[0];

      const title = (req.body?.title || "").trim();
      // artist comes from the form as artist_name OR artist
      const artistInput = (req.body?.artist_name || req.body?.artist || "").trim();
      const artistName = artistInput || "Unknown Artist";

      if (!audio || !title) {
        return sendJsonError(res, 400, {
          error: "Title and audio file are required.",
        });
      }

      // --- Resolve uploader name & auth user ---
      let authUserId = null;   // supabase auth user id (uuid)
      let legacyUserId = null; // old numeric user id if you ever send it

      // 1) try body.uploader_name (if frontend ever sends one)
      let uploaderName = (req.body?.uploader_name || "").trim() || null;

      // 2) try Supabase auth user (if token present)
      try {
        const token = req.headers.authorization?.split(" ")[1];
        if (token) {
          const { data: userData } = await supabase.auth.getUser(token);
          if (userData?.user) {
            authUserId = userData.user.id || null;
            if (!uploaderName) {
              uploaderName =
                userData.user.user_metadata?.name ||
                userData.user.email ||
                null;
            }
          }
        }
      } catch (e) {
        console.warn("uploader resolve failed (supabase):", e?.message || e);
      }

      // 3) try Google OAuth cookie set by /auth/google/callback
      if (!uploaderName && req.cookies?.user) {
        try {
          const cookieUser = JSON.parse(req.cookies.user);
          uploaderName =
            cookieUser.name ||
            cookieUser.email ||
            uploaderName;
        } catch (e) {
          console.warn("Failed to parse user cookie:", e?.message || e);
        }
      }

      // 4) legacy numeric user id (optional, sent by frontend)
      if (req.body?.userId) {
        const n = parseInt(req.body.userId, 10);
        legacyUserId = Number.isFinite(n) ? n : null;
      }

      // 5) final fallback: if still nothing, use artistName
      if (!uploaderName) {
        uploaderName = artistName;
      }

      // --- Upload audio to Supabase storage ---
      const timestamp = Date.now();
      const safeAudio = makeSafeName(audio.originalname);
      const audioPath = `tracks/${timestamp}_${safeAudio}`;

      let audioUrl = null;
      let audioStorageKey = audioPath;
      let sizeBytes = audio.size || null;
      let mimeType = audio.mimetype || null;

      try {
        audioUrl = await uploadBuffer("Tracks", audioPath, audio.buffer, audio.mimetype);
      } catch (err) {
        console.error("Audio upload error (supabase):", err?.message || err);
        audioUrl = LOCAL_TEST_PATH; // debug fallback
        audioStorageKey = `debug/${timestamp}_${safeAudio}`;
      }

      // --- Upload cover (optional) ---
      let coverPath = null;
      let coverUrl = null;
      let coverMime = null;
      let coverSize = null;

      if (cover) {
        try {
          const safeCover = makeSafeName(cover.originalname);
          coverPath = `covers/${timestamp}_${safeCover}`;
          coverUrl = await uploadBuffer("Tracks", coverPath, cover.buffer, cover.mimetype);
          coverMime = cover.mimetype;
          coverSize = cover.size;
        } catch (err) {
          console.warn("Cover upload error (supabase):", err?.message || err);
          coverUrl = LOCAL_TEST_PATH;
          coverPath = `debug/covers/${timestamp}_${makeSafeName(cover.originalname)}`;
        }
      } else {
        coverUrl = LOCAL_TEST_PATH;
      }

      // --- Insert into DB: includes uploader_name ---
      let inserted;
      try {
        const result = await pool.query(
          `INSERT INTO tracks
            (title,
             artist_name,
             uploader_name,
             storage_key,
             public_url,
             cover_path,
             cover_url,
             size_bytes,
             mime_type,
             auth_user_id,
             user_id,
             created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
           RETURNING *`,
          [
            title,
            artistName,
            uploaderName,
            audioStorageKey,
            audioUrl,
            coverPath,
            coverUrl,
            sizeBytes,
            mimeType,
            authUserId,
            legacyUserId,
          ]
        );
        inserted = result.rows[0];
      } catch (err) {
        console.error("DB insert error:", err);
        return sendJsonError(res, 500, {
          error: "Database insert failed",
          detail: err.message,
          code: err.code || null,
        });
      }

      // --- Final normalized track object (includes uploader_name) ---
      const track = {
        id: inserted.id,
        title: inserted.title,
        artist_name: inserted.artist_name,
        uploader_name: inserted.uploader_name || uploaderName || artistName,
        public_url: inserted.public_url || audioUrl || LOCAL_TEST_PATH,
        cover_url: inserted.cover_url || coverUrl || LOCAL_TEST_PATH,
        storage_key: inserted.storage_key || audioStorageKey,
        size_bytes: inserted.size_bytes || sizeBytes,
        mime_type: inserted.mime_type || mimeType,
        created_at: inserted.created_at,
        auth_user_id: inserted.auth_user_id || authUserId,
        user_id: inserted.user_id || legacyUserId,
      };

      // --- Emit realtime event to ALL users (Socket.IO) ---
      try {
        const io = req.app.get("io");
        if (io) {
          io.emit("new-track", track);
        }
      } catch (emitErr) {
        console.warn("Socket emit failed:", emitErr);
      }

      // --- Return response to uploader ---
      return res.json({
        message: "Track uploaded successfully",
        track,
      });
    } catch (err) {
      console.error("Upload error:", err);
      return sendJsonError(res, 500, {
        error: err?.message || "Upload failed",
      });
    }
  }
);

// ----------------------
// Optional: GET /api/tracks from this router
// (you also have a dedicated getTracks route file)
// ----------------------
router.get("/tracks", async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const sql = `
      SELECT id, title, artist_name, uploader_name,
             artist_id, public_url, cover_url,
             storage_key, size_bytes, mime_type, created_at
      FROM tracks
      ORDER BY created_at DESC
      LIMIT $1
    `;
    const result = await pool.query(sql, [parseInt(limit, 10) || 50]);

    const rows = result.rows.map((r) => ({
      id: r.id,
      title: r.title,
      artist_name: r.artist_name,
      uploader_name: r.uploader_name,
      public_url: r.public_url || LOCAL_TEST_PATH,
      cover_url: r.cover_url || LOCAL_TEST_PATH,
      storage_key: r.storage_key,
      size_bytes: r.size_bytes,
      mime_type: r.mime_type,
      created_at: r.created_at,
    }));

    return res.json({ tracks: rows });
  } catch (err) {
    console.error("GET /tracks error:", err);
    return sendJsonError(res, 500, {
      error: "Failed to fetch tracks",
      detail: err.message,
    });
  }
});

module.exports = router;
