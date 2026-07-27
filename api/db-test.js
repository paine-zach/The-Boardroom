import { sql } from "../lib/db.js";

export default async function handler(req, res) {
  try {
    const tables = await sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `;

    return res.status(200).json({
      connected: true,
      tables,
    });
  } catch (error) {
    console.error("Database test failed:", error);

    return res.status(500).json({
      connected: false,
      error: String(error?.message || error),
    });
  }
}