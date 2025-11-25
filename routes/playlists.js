const express = require("express");
const router = express.Router();
const dbModule = require("../db"); // may export Pool OR { pool, query, shutdownPool }
const supabase = require("../supabaseClient");

// Local debug image path (from conversation history)
const SAMPLE_IMAGE_PATH = "/mnt/data/Screenshot 2025-11-25 at 11.38.56 PM.png";

/**
 * Helper to run a query regardless of db export shape.
 * If your db file exports `query`, use it. Otherwise assume it's a Pool.
 */
async function dbQuery(text, params) {
  if (typeof dbModule.query === "function") {
    return dbModule.query(text, params);
  }
  const pool = dbModule.pool || dbModule;
  return pool.query(text, params);
}

/**
 * Resolve local integer user id from Supabase bearer token (UUID).
 * If a local user row doesn't exist, create one (keeps mapping).
 * Returns integer user_id or null if token invalid.
 */
async function getLocalUserIdFromToken(req) {
  try {
    const authHeader = req.headers.authorization || req.cookies?.authorization || req.cookies?.token;
    const token = authHeader?.split?.(" ")?.[1] || authHeader;
    if (!token) return null;

    // Attempt to resolve user via Supabase server SDK (token expected)
    // Note: supabase.auth.getUser may behave differently depending on SDK version.
    const { data, error } = await supabase.auth.getUser(token).catch((e) => ({ error: e }));
    if (error || !data?.user) {
      console.warn("Supabase token invalid or error:", error?.message || error);
      return null;
    }
    const supaUserId = data.user.id;

    // Try to find local user row with that auth_user_id
    const q = await dbQuery("SELECT id FROM users WHERE auth_user_id = $1 LIMIT 1", [supaUserId]);
    if (q.rows && q.rows.length > 0) return q.rows[0].id;

    // If not found, create a local user mapping (name/email may be null)
    const insert = await dbQuery(
      "INSERT INTO users (name, email, auth_user_id) VALUES ($1,$2,$3) RETURNING id",
      [data.user.user_metadata?.name || null, data.user.email || null, supaUserId]
    );
    return insert.rows[0].id;
  } catch (err) {
    console.error("getLocalUserIdFromToken error:", err);
    return null;
  }
}

// ---------------------------
// GET /api/playlists
// list playlists for current user (with track objects)
// includes sample_image path in payload for client convenience
// ---------------------------
router.get("/", async (req, res) => {
  try {
    const userId = await getLocalUserIdFromToken(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const playlistsRes = await dbQuery(
      "SELECT id, name, created_at FROM playlists WHERE user_id = $1 ORDER BY created_at DESC",
      [userId]
    );
    const playlists = playlistsRes.rows || [];

    const withTracks = await Promise.all(
      playlists.map(async (pl) => {
        const tRes = await dbQuery(
          `SELECT ps.track_id, t.title, t.public_url, t.cover_url, t.duration_seconds
           FROM playlist_songs ps
           LEFT JOIN tracks t ON t.id = ps.track_id
           WHERE ps.playlist_id = $1
           ORDER BY ps.added_at ASC`,
          [pl.id]
        );
        return { ...pl, tracks: tRes.rows || [] };
      })
    );

    // return sample_image path (you said you'd transform locally)
    res.json({ playlists: withTracks, sample_image: SAMPLE_IMAGE_PATH });
  } catch (err) {
    console.error("GET /api/playlists error:", err);
    res.status(500).json({ error: "Failed to list playlists" });
  }
});

// ---------------------------
// POST /api/playlists -> create playlist
// body: { name }
// ---------------------------
router.post("/", async (req, res) => {
  try {
    const userId = await getLocalUserIdFromToken(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) return res.status(400).json({ error: "Name is required" });

    const { rows } = await dbQuery(
      "INSERT INTO playlists (user_id, name) VALUES ($1, $2) RETURNING id, name, created_at",
      [userId, name]
    );
    const created = rows[0];

    // emit playlist-created event via socket if available
    try {
      const io = req.app?.get("io");
      if (io) io.emit("playlist-created", { playlist: created, userId });
    } catch (e) {
      // non-fatal
      console.warn("Could not emit socket playlist-created:", e);
    }

    res.status(201).json(created);
  } catch (err) {
    console.error("POST /api/playlists error:", err);
    res.status(500).json({ error: "Failed to create playlist" });
  }
});

// ---------------------------
// Compatibility endpoints for adding/removing tracks
// - new preferred path: /:playlistId/add-track and /:playlistId/remove-track
// - older path (/add and /remove) preserved for backward compatibility
// ---------------------------

async function handleAddTrack(req, res) {
  try {
    const userId = await getLocalUserIdFromToken(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const playlistId = parseInt(req.params.playlistId, 10);
    const trackId = parseInt(req.body.trackId, 10);
    if (!Number.isInteger(playlistId) || !Number.isInteger(trackId)) {
      return res.status(400).json({ error: "playlistId and trackId must be integers" });
    }

    // verify ownership
    const plRes = await dbQuery("SELECT user_id FROM playlists WHERE id = $1 LIMIT 1", [playlistId]);
    if (!plRes.rows[0] || plRes.rows[0].user_id !== userId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // insert if not exists
    const insertRes = await dbQuery(
      "INSERT INTO playlist_songs (playlist_id, track_id, added_at) VALUES ($1,$2,NOW()) ON CONFLICT (playlist_id, track_id) DO NOTHING RETURNING *",
      [playlistId, trackId]
    );

    // emit socket event (playlist updated)
    try {
      const io = req.app?.get("io");
      if (io) {
        io.emit("playlist-updated", { playlistId, trackId, added: insertRes.rows?.length > 0 });
      }
    } catch (e) {
      console.warn("Could not emit socket playlist-updated:", e);
    }

    res.json({ success: true, inserted: insertRes.rows?.length > 0 });
  } catch (err) {
    console.error("ADD TRACK error:", err);
    res.status(500).json({ error: "Failed to add track to playlist" });
  }
}

async function handleRemoveTrack(req, res) {
  try {
    const userId = await getLocalUserIdFromToken(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const playlistId = parseInt(req.params.playlistId, 10);
    const trackId = parseInt(req.body.trackId, 10);
    if (!Number.isInteger(playlistId) || !Number.isInteger(trackId)) {
      return res.status(400).json({ error: "playlistId and trackId must be integers" });
    }

    // verify ownership
    const plRes = await dbQuery("SELECT user_id FROM playlists WHERE id = $1 LIMIT 1", [playlistId]);
    if (!plRes.rows[0] || plRes.rows[0].user_id !== userId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const del = await dbQuery("DELETE FROM playlist_songs WHERE playlist_id = $1 AND track_id = $2", [playlistId, trackId]);

    // emit socket
    try {
      const io = req.app?.get("io");
      if (io) io.emit("playlist-updated", { playlistId, trackId, removed: true });
    } catch (e) {
      console.warn("Could not emit socket playlist-updated:", e);
    }

    res.json({ success: true, deletedRows: del.rowCount ?? (del.rows ? del.rows.length : null) });
  } catch (err) {
    console.error("REMOVE TRACK error:", err);
    res.status(500).json({ error: "Failed to remove track from playlist" });
  }
}

// preferred
router.post("/:playlistId/add-track", handleAddTrack);
router.post("/:playlistId/remove-track", handleRemoveTrack);

// backward-compatible (older clients)
router.post("/:playlistId/add", handleAddTrack);
router.post("/:playlistId/remove", handleRemoveTrack);

module.exports = router;
