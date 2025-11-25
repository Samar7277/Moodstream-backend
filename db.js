// db.js
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, 
  max: 10,                        
  idleTimeoutMillis: 30_000,      
  connectionTimeoutMillis: 20_000 
});


pool.on("error", (err, client) => {
  console.error("[PG pool] unexpected idle client error", err);
  
});


async function query(text, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } catch (err) {
    
    console.error("[DB query error]", { text, params, err: err.message });
    throw err;
  } finally {
    client.release();
  }
}


async function shutdownPool() {
  try {
    console.log("[DB] shutting down pool...");
    await pool.end();
    console.log("[DB] pool shut down complete.");
  } catch (err) {
    console.error("[DB] error while shutting down pool:", err);
  }
}

module.exports = {
  pool,
  query,
  shutdownPool,
};
