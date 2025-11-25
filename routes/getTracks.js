const express = require("express");
const router = express.Router();
const supabase = require("../supabaseClient");

router.get("/", async (req, res) => {
  try {
    const { data, error } = await supabase.from("tracks").select("*");

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Generate public URLs
    const tracks = data.map(track => {
      const { data: urlData } = supabase.storage
        .from("tracks")
        .getPublicUrl(track.storage_key);

      return {
        ...track,
        public_url: urlData.publicUrl
      };
    });

    res.json({ tracks });

  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
