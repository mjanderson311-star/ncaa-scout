'use strict';
const { Pool } = require('pg');

// ─── Connection config ──────────────────────────────────────────────────────
// On Windows, PostgreSQL usually requires a password.
// Set DATABASE_URL in your environment or a .env file:
//   postgresql://postgres:yourpassword@localhost/ncaa_scout
//
// Or set individual vars: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE

const DB_NAME = process.env.PGDATABASE || 'ncaa_scout';

function makePoolConfig(dbName) {
  if (process.env.DATABASE_URL) {
    // Replace database name in URL if needed
    const url = process.env.DATABASE_URL.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
    return { connectionString: url, max: 10 };
  }
  return {
    host:     process.env.PGHOST     || 'localhost',
    port:     Number(process.env.PGPORT || 5432),
    user:     process.env.PGUSER     || process.env.USERNAME || 'postgres',
    password: process.env.PGPASSWORD || undefined,
    database: dbName,
    max: 10,
  };
}

const pool = new Pool(makePoolConfig(DB_NAME));

// ─── Schema ────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
-- Divisions: D1, D2, D3
-- Sport codes: MBA = Men's Baseball

CREATE TABLE IF NOT EXISTS ncaa_teams (
  ncaa_team_id      BIGINT PRIMARY KEY,   -- stats.ncaa.org team id (from URL /teams/:id)
  org_id            VARCHAR(50),          -- NCAA org id (used in some URLs)
  name              VARCHAR(200) NOT NULL,
  short_name        VARCHAR(100),
  division          VARCHAR(10),          -- 'D1','D2','D3'
  conference        VARCHAR(150),
  state             VARCHAR(5),
  sport_code        VARCHAR(10) DEFAULT 'MBA',
  base_url          VARCHAR(400),         -- stats.ncaa.org/teams/:id
  last_scraped_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ncaa_seasons (
  id                SERIAL PRIMARY KEY,
  ncaa_team_id      BIGINT REFERENCES ncaa_teams(ncaa_team_id),
  academic_year     INT NOT NULL,         -- e.g. 2025 means 2024-25
  season_id         BIGINT NOT NULL,      -- stats.ncaa.org season id
  division          VARCHAR(10),
  sport_code        VARCHAR(10) DEFAULT 'MBA',
  games_scraped     INT DEFAULT 0,
  scraped_at        TIMESTAMPTZ,
  UNIQUE(ncaa_team_id, academic_year, sport_code)
);

CREATE TABLE IF NOT EXISTS ncaa_games (
  id                SERIAL PRIMARY KEY,
  ncaa_team_id      BIGINT REFERENCES ncaa_teams(ncaa_team_id),
  academic_year     INT NOT NULL,
  contest_id        BIGINT,               -- stats.ncaa.org contest id
  game_date         DATE,
  opponent_name     VARCHAR(200),
  opponent_team_id  BIGINT,
  is_away           BOOLEAN DEFAULT FALSE,
  is_neutral        BOOLEAN DEFAULT FALSE,
  our_score         INT,
  opp_score         INT,
  result            CHAR(1),              -- 'W','L','T'
  innings           INT DEFAULT 9,
  pbp_scraped       BOOLEAN DEFAULT FALSE,
  pbp_scraped_at    TIMESTAMPTZ,
  raw_result_text   VARCHAR(100),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(ncaa_team_id, contest_id)
);

CREATE TABLE IF NOT EXISTS ncaa_players (
  id                SERIAL PRIMARY KEY,
  ncaa_team_id      BIGINT REFERENCES ncaa_teams(ncaa_team_id),
  ncaa_player_id    BIGINT NOT NULL,      -- stats.ncaa.org player id
  academic_year     INT NOT NULL,
  name              VARCHAR(200),
  jersey_number     VARCHAR(10),
  position          VARCHAR(50),
  class_year        VARCHAR(20),          -- Fr, So, Jr, Sr, Gr
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(ncaa_team_id, ncaa_player_id, academic_year)
);

CREATE TABLE IF NOT EXISTS ncaa_plays (
  id                BIGSERIAL PRIMARY KEY,
  game_id           INT REFERENCES ncaa_games(id) ON DELETE CASCADE,
  inning            INT,
  half              CHAR(3),              -- 'top','bot'
  sequence          INT,                  -- order within half-inning
  raw_text          TEXT,
  play_type         VARCHAR(50),          -- 'strikeout','walk','single','double','triple','hr','out','error','sac','hbp','wp','pb','balk','steal','caught_stealing','pickoff','other'
  batter_name       VARCHAR(200),
  pitcher_name      VARCHAR(200),
  batter_player_id  BIGINT,
  pitcher_player_id BIGINT,
  runners_on        VARCHAR(20),          -- '1B','2B','3B','12','13','23','123',''
  outs_before       INT,
  rbi               INT DEFAULT 0,
  runs_scored       INT DEFAULT 0,
  is_scoring_play   BOOLEAN DEFAULT FALSE,
  away_score_after  INT,
  home_score_after  INT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ncaa_plays_game     ON ncaa_plays(game_id);
CREATE INDEX IF NOT EXISTS idx_ncaa_plays_type     ON ncaa_plays(play_type);
CREATE INDEX IF NOT EXISTS idx_ncaa_games_team     ON ncaa_games(ncaa_team_id, academic_year);
CREATE INDEX IF NOT EXISTS idx_ncaa_players_team   ON ncaa_players(ncaa_team_id, academic_year);

-- Aggregated batting stats per player per season (computed from plays, or direct from NCAA game-by-game page)
CREATE TABLE IF NOT EXISTS ncaa_batting_stats (
  id                SERIAL PRIMARY KEY,
  ncaa_team_id      BIGINT REFERENCES ncaa_teams(ncaa_team_id),
  ncaa_player_id    BIGINT,
  academic_year     INT NOT NULL,
  g                 INT DEFAULT 0,
  ab                INT DEFAULT 0,
  r                 INT DEFAULT 0,
  h                 INT DEFAULT 0,
  doubles           INT DEFAULT 0,
  triples           INT DEFAULT 0,
  hr                INT DEFAULT 0,
  rbi               INT DEFAULT 0,
  bb                INT DEFAULT 0,
  so                INT DEFAULT 0,
  sb                INT DEFAULT 0,
  cs                INT DEFAULT 0,
  hbp               INT DEFAULT 0,
  sf                INT DEFAULT 0,
  sh                INT DEFAULT 0,
  avg               NUMERIC(5,3),
  obp               NUMERIC(5,3),
  slg               NUMERIC(5,3),
  ops               NUMERIC(5,3),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(ncaa_team_id, ncaa_player_id, academic_year)
);

CREATE TABLE IF NOT EXISTS ncaa_pitching_stats (
  id                SERIAL PRIMARY KEY,
  ncaa_team_id      BIGINT REFERENCES ncaa_teams(ncaa_team_id),
  ncaa_player_id    BIGINT,
  academic_year     INT NOT NULL,
  g                 INT DEFAULT 0,
  gs                INT DEFAULT 0,
  w                 INT DEFAULT 0,
  l                 INT DEFAULT 0,
  sv                INT DEFAULT 0,
  ip                NUMERIC(6,1),
  h                 INT DEFAULT 0,
  r                 INT DEFAULT 0,
  er                INT DEFAULT 0,
  bb                INT DEFAULT 0,
  so                INT DEFAULT 0,
  hr                INT DEFAULT 0,
  hbp               INT DEFAULT 0,
  era               NUMERIC(5,2),
  whip              NUMERIC(5,3),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(ncaa_team_id, ncaa_player_id, academic_year)
);
`;

async function ensureDatabase() {
  // Try connecting to the target DB; if it doesn't exist, create it via the postgres admin DB
  try {
    const testPool = new Pool({ ...makePoolConfig(DB_NAME), max: 1 });
    const client = await testPool.connect();
    client.release();
    await testPool.end();
    return; // DB exists
  } catch (err) {
    if (!/database.*does not exist|3D000/.test(err.message || err.code || '')) throw err;
  }

  // Database doesn't exist — connect to default 'postgres' DB and create it
  console.log(`[db] Database "${DB_NAME}" not found, creating it...`);
  const adminPool = new Pool({ ...makePoolConfig('postgres'), max: 1 });
  const client = await adminPool.connect();
  try {
    await client.query(`CREATE DATABASE "${DB_NAME}"`);
    console.log(`[db] Created database "${DB_NAME}"`);
  } finally {
    client.release();
    await adminPool.end();
  }
}

async function initSchema() {
  // Auto-create DB if needed (works on Windows without createdb command)
  await ensureDatabase();

  const client = await pool.connect();
  try {
    await client.query(SCHEMA_SQL);
    console.log('[db] Schema initialized');
  } finally {
    client.release();
  }
}

// ─── Team helpers ──────────────────────────────────────────────────────────

async function upsertTeam(t) {
  const sql = `
    INSERT INTO ncaa_teams (ncaa_team_id, org_id, name, short_name, division, conference, state, sport_code, base_url, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
    ON CONFLICT (ncaa_team_id) DO UPDATE SET
      name=EXCLUDED.name, short_name=EXCLUDED.short_name,
      division=EXCLUDED.division, conference=EXCLUDED.conference,
      state=EXCLUDED.state, base_url=EXCLUDED.base_url, updated_at=NOW()
    RETURNING *`;
  const { rows } = await pool.query(sql, [t.ncaa_team_id, t.org_id||null, t.name, t.short_name||null, t.division||null, t.conference||null, t.state||null, t.sport_code||'MBA', t.base_url||null]);
  return rows[0];
}

async function getTeam(ncaa_team_id) {
  const { rows } = await pool.query('SELECT * FROM ncaa_teams WHERE ncaa_team_id=$1', [ncaa_team_id]);
  return rows[0] || null;
}

async function deleteTeam(ncaa_team_id) {
  // Cascade: plays → games → seasons → team
  await pool.query(`DELETE FROM ncaa_plays   WHERE game_id IN (SELECT id FROM ncaa_games WHERE ncaa_team_id=$1)`, [ncaa_team_id]);
  await pool.query(`DELETE FROM ncaa_batting_stats  WHERE ncaa_team_id=$1`, [ncaa_team_id]);
  await pool.query(`DELETE FROM ncaa_pitching_stats WHERE ncaa_team_id=$1`, [ncaa_team_id]);
  await pool.query(`DELETE FROM ncaa_players  WHERE ncaa_team_id=$1`, [ncaa_team_id]);
  await pool.query(`DELETE FROM ncaa_games    WHERE ncaa_team_id=$1`, [ncaa_team_id]);
  await pool.query(`DELETE FROM ncaa_seasons  WHERE ncaa_team_id=$1`, [ncaa_team_id]);
  await pool.query(`DELETE FROM ncaa_teams    WHERE ncaa_team_id=$1`, [ncaa_team_id]);
}

async function searchTeams({ name, conference, division, sport_code = 'MBA' }) {
  const conds = ['sport_code=$1'];
  const vals = [sport_code];
  if (name)       { vals.push(`%${name}%`);       conds.push(`name ILIKE $${vals.length}`); }
  if (conference) { vals.push(`%${conference}%`);  conds.push(`conference ILIKE $${vals.length}`); }
  if (division)   { vals.push(division);            conds.push(`division=$${vals.length}`); }
  const sql = `SELECT * FROM ncaa_teams WHERE ${conds.join(' AND ')} ORDER BY name LIMIT 100`;
  const { rows } = await pool.query(sql, vals);
  return rows;
}

async function getAllTeams(division = null, sport_code = 'MBA') {
  if (division) {
    const { rows } = await pool.query('SELECT * FROM ncaa_teams WHERE sport_code=$1 AND division=$2 ORDER BY conference, name', [sport_code, division]);
    return rows;
  }
  const { rows } = await pool.query('SELECT * FROM ncaa_teams WHERE sport_code=$1 ORDER BY conference, name', [sport_code]);
  return rows;
}

async function markTeamScraped(ncaa_team_id) {
  await pool.query('UPDATE ncaa_teams SET last_scraped_at=NOW() WHERE ncaa_team_id=$1', [ncaa_team_id]);
}

// ─── Season helpers ────────────────────────────────────────────────────────

async function upsertSeason(s) {
  const sql = `
    INSERT INTO ncaa_seasons (ncaa_team_id, academic_year, season_id, division, sport_code)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (ncaa_team_id, academic_year, sport_code) DO UPDATE SET
      season_id=EXCLUDED.season_id, division=EXCLUDED.division
    RETURNING *`;
  const { rows } = await pool.query(sql, [s.ncaa_team_id, s.academic_year, s.season_id, s.division||null, s.sport_code||'MBA']);
  return rows[0];
}

async function markSeasonScraped(ncaa_team_id, academic_year, sport_code = 'MBA', count = 0) {
  await pool.query(
    'UPDATE ncaa_seasons SET scraped_at=NOW(), games_scraped=$4 WHERE ncaa_team_id=$1 AND academic_year=$2 AND sport_code=$3',
    [ncaa_team_id, academic_year, sport_code, count]
  );
}

// ─── Game helpers ──────────────────────────────────────────────────────────

async function upsertGame(g) {
  const sql = `
    INSERT INTO ncaa_games (ncaa_team_id, academic_year, contest_id, game_date, opponent_name, opponent_team_id, is_away, is_neutral, our_score, opp_score, result, innings, raw_result_text)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (ncaa_team_id, contest_id) DO UPDATE SET
      game_date=EXCLUDED.game_date, opponent_name=EXCLUDED.opponent_name,
      opponent_team_id=EXCLUDED.opponent_team_id, is_away=EXCLUDED.is_away,
      is_neutral=EXCLUDED.is_neutral, our_score=EXCLUDED.our_score,
      opp_score=EXCLUDED.opp_score, result=EXCLUDED.result,
      innings=EXCLUDED.innings, raw_result_text=EXCLUDED.raw_result_text
    RETURNING *`;
  const { rows } = await pool.query(sql, [
    g.ncaa_team_id, g.academic_year, g.contest_id,
    g.game_date || null, g.opponent_name || null, g.opponent_team_id || null,
    g.is_away || false, g.is_neutral || false,
    g.our_score ?? null, g.opp_score ?? null,
    g.result || null, g.innings || 9, g.raw_result_text || null,
  ]);
  return rows[0];
}

async function getGames(ncaa_team_id, academic_year) {
  const { rows } = await pool.query(
    'SELECT * FROM ncaa_games WHERE ncaa_team_id=$1 AND academic_year=$2 ORDER BY game_date, id',
    [ncaa_team_id, academic_year]
  );
  return rows;
}

async function getGame(id) {
  const { rows } = await pool.query('SELECT * FROM ncaa_games WHERE id=$1', [id]);
  return rows[0] || null;
}

async function markGamePbpScraped(game_id) {
  await pool.query('UPDATE ncaa_games SET pbp_scraped=TRUE, pbp_scraped_at=NOW() WHERE id=$1', [game_id]);
}

async function getUnscrapedGames(ncaa_team_id, academic_year) {
  const { rows } = await pool.query(
    'SELECT * FROM ncaa_games WHERE ncaa_team_id=$1 AND academic_year=$2 AND pbp_scraped=FALSE AND contest_id IS NOT NULL ORDER BY game_date',
    [ncaa_team_id, academic_year]
  );
  return rows;
}

// Reset pbp_scraped flag so PBP is re-scraped on next run.
// Also deletes existing (possibly bad) play data for those games.
async function resetPbpScraped(ncaa_team_id, academic_year) {
  // Delete existing plays for this team/year
  await pool.query(
    `DELETE FROM ncaa_plays WHERE game_id IN (
       SELECT id FROM ncaa_games WHERE ncaa_team_id=$1 AND academic_year=$2
     )`,
    [ncaa_team_id, academic_year]
  );
  // Reset the scraped flag
  const { rowCount } = await pool.query(
    'UPDATE ncaa_games SET pbp_scraped=FALSE, pbp_scraped_at=NULL WHERE ncaa_team_id=$1 AND academic_year=$2',
    [ncaa_team_id, academic_year]
  );
  return rowCount;
}

// ─── Player helpers ────────────────────────────────────────────────────────

async function upsertPlayer(p) {
  const sql = `
    INSERT INTO ncaa_players (ncaa_team_id, ncaa_player_id, academic_year, name, jersey_number, position, class_year, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
    ON CONFLICT (ncaa_team_id, ncaa_player_id, academic_year) DO UPDATE SET
      name=COALESCE(EXCLUDED.name, ncaa_players.name),
      jersey_number=COALESCE(EXCLUDED.jersey_number, ncaa_players.jersey_number),
      position=COALESCE(EXCLUDED.position, ncaa_players.position),
      class_year=COALESCE(EXCLUDED.class_year, ncaa_players.class_year),
      updated_at=NOW()
    RETURNING *`;
  const { rows } = await pool.query(sql, [p.ncaa_team_id, p.ncaa_player_id, p.academic_year, p.name||null, p.jersey_number||null, p.position||null, p.class_year||null]);
  return rows[0];
}

async function getPlayers(ncaa_team_id, academic_year) {
  const { rows } = await pool.query(
    'SELECT * FROM ncaa_players WHERE ncaa_team_id=$1 AND academic_year=$2 ORDER BY jersey_number::int NULLS LAST, name',
    [ncaa_team_id, academic_year]
  );
  return rows;
}

// ─── Play helpers ──────────────────────────────────────────────────────────

async function insertPlays(game_id, plays) {
  if (!plays || plays.length === 0) return;
  // Delete existing plays for this game first
  await pool.query('DELETE FROM ncaa_plays WHERE game_id=$1', [game_id]);
  // Bulk insert
  const chunks = [];
  const vals = [];
  let i = 1;
  for (const p of plays) {
    chunks.push(`($${i},$${i+1},$${i+2},$${i+3},$${i+4},$${i+5},$${i+6},$${i+7},$${i+8},$${i+9},$${i+10},$${i+11},$${i+12},$${i+13},$${i+14})`);
    vals.push(
      game_id, p.inning||null, p.half||null, p.sequence||null,
      p.raw_text||null, p.play_type||'other',
      p.batter_name||null, p.pitcher_name||null,
      p.batter_player_id||null, p.pitcher_player_id||null,
      p.runners_on||null, p.outs_before??null,
      p.rbi||0, p.runs_scored||0, p.is_scoring_play||false
    );
    i += 15;
  }
  const sql = `INSERT INTO ncaa_plays (game_id,inning,half,sequence,raw_text,play_type,batter_name,pitcher_name,batter_player_id,pitcher_player_id,runners_on,outs_before,rbi,runs_scored,is_scoring_play) VALUES ${chunks.join(',')}`;
  await pool.query(sql, vals);
}

async function getPlays(game_id) {
  const { rows } = await pool.query(
    'SELECT * FROM ncaa_plays WHERE game_id=$1 ORDER BY inning, half, sequence',
    [game_id]
  );
  return rows;
}

// ─── Stats helpers ─────────────────────────────────────────────────────────

async function upsertBattingStats(s) {
  const sql = `
    INSERT INTO ncaa_batting_stats (ncaa_team_id, ncaa_player_id, academic_year, g, ab, r, h, doubles, triples, hr, rbi, bb, so, sb, cs, hbp, sf, sh, avg, obp, slg, ops, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NOW())
    ON CONFLICT (ncaa_team_id, ncaa_player_id, academic_year) DO UPDATE SET
      g=$4, ab=$5, r=$6, h=$7, doubles=$8, triples=$9, hr=$10, rbi=$11,
      bb=$12, so=$13, sb=$14, cs=$15, hbp=$16, sf=$17, sh=$18,
      avg=$19, obp=$20, slg=$21, ops=$22, updated_at=NOW()`;
  await pool.query(sql, [
    s.ncaa_team_id, s.ncaa_player_id, s.academic_year,
    s.g||0, s.ab||0, s.r||0, s.h||0, s.doubles||0, s.triples||0, s.hr||0,
    s.rbi||0, s.bb||0, s.so||0, s.sb||0, s.cs||0, s.hbp||0, s.sf||0, s.sh||0,
    s.avg||null, s.obp||null, s.slg||null, s.ops||null,
  ]);
}

async function upsertPitchingStats(s) {
  const sql = `
    INSERT INTO ncaa_pitching_stats (ncaa_team_id, ncaa_player_id, academic_year, g, gs, w, l, sv, ip, h, r, er, bb, so, hr, hbp, era, whip, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
    ON CONFLICT (ncaa_team_id, ncaa_player_id, academic_year) DO UPDATE SET
      g=$4, gs=$5, w=$6, l=$7, sv=$8, ip=$9, h=$10, r=$11, er=$12,
      bb=$13, so=$14, hr=$15, hbp=$16, era=$17, whip=$18, updated_at=NOW()`;
  await pool.query(sql, [
    s.ncaa_team_id, s.ncaa_player_id, s.academic_year,
    s.g||0, s.gs||0, s.w||0, s.l||0, s.sv||0, s.ip||null,
    s.h||0, s.r||0, s.er||0, s.bb||0, s.so||0, s.hr||0, s.hbp||0,
    s.era||null, s.whip||null,
  ]);
}

async function getBattingStats(ncaa_team_id, academic_year) {
  const { rows } = await pool.query(
    `SELECT bs.*, p.name, p.jersey_number, p.position, p.class_year
     FROM ncaa_batting_stats bs
     LEFT JOIN ncaa_players p ON p.ncaa_team_id=bs.ncaa_team_id AND p.ncaa_player_id=bs.ncaa_player_id AND p.academic_year=bs.academic_year
     WHERE bs.ncaa_team_id=$1 AND bs.academic_year=$2
     ORDER BY bs.ab DESC NULLS LAST`,
    [ncaa_team_id, academic_year]
  );
  return rows;
}

async function getPitchingStats(ncaa_team_id, academic_year) {
  const { rows } = await pool.query(
    `SELECT ps.*, p.name, p.jersey_number, p.position, p.class_year
     FROM ncaa_pitching_stats ps
     LEFT JOIN ncaa_players p ON p.ncaa_team_id=ps.ncaa_team_id AND p.ncaa_player_id=ps.ncaa_player_id AND p.academic_year=ps.academic_year
     WHERE ps.ncaa_team_id=$1 AND ps.academic_year=$2
     ORDER BY ps.ip DESC NULLS LAST`,
    [ncaa_team_id, academic_year]
  );
  return rows;
}

async function getSeasonPlays(ncaa_team_id, academic_year) {
  const { rows } = await pool.query(
    `SELECT p.* FROM ncaa_plays p
     JOIN ncaa_games g ON g.id = p.game_id
     WHERE g.ncaa_team_id=$1 AND g.academic_year=$2
     ORDER BY g.game_date, p.inning,
              CASE WHEN p.half='top' THEN 0 ELSE 1 END, p.sequence`,
    [ncaa_team_id, academic_year]
  );
  return rows;
}

async function getPlaysNeedingResolution(ncaa_team_id, academic_year) {
  const { rows } = await pool.query(
    `SELECT p.id, p.raw_text, p.play_type, p.half,
            g.ncaa_team_id, g.opponent_team_id, g.is_away
     FROM ncaa_plays p
     JOIN ncaa_games g ON g.id = p.game_id
     WHERE g.ncaa_team_id = $1 AND g.academic_year = $2
       AND p.batter_name IS NULL
       AND p.raw_text IS NOT NULL
     ORDER BY g.game_date, p.id`,
    [ncaa_team_id, academic_year]
  );
  return rows;
}

async function updatePlayBatter(play_id, batter_name, batter_player_id) {
  await pool.query(
    `UPDATE ncaa_plays SET batter_name=$2, batter_player_id=$3 WHERE id=$1`,
    [play_id, batter_name || null, batter_player_id || null]
  );
}

async function updatePlayPitcher(play_id, pitcher_name) {
  await pool.query(
    `UPDATE ncaa_plays SET pitcher_name=$2 WHERE id=$1`,
    [play_id, pitcher_name || null]
  );
}

async function getAllPlaysForSeason(ncaa_team_id, academic_year) {
  // All plays for games involving this team, ordered by game then play sequence.
  // Includes games where the team is home OR away (opponent_team_id match too).
  const { rows } = await pool.query(
    `SELECT p.id, p.game_id, p.inning, p.half, p.sequence, p.raw_text, p.play_type
     FROM ncaa_plays p
     JOIN ncaa_games g ON g.id = p.game_id
     WHERE g.ncaa_team_id = $1 AND g.academic_year = $2
       AND p.raw_text IS NOT NULL
     ORDER BY g.game_date, p.game_id,
              p.inning,
              CASE WHEN p.half='top' THEN 0 ELSE 1 END,
              p.sequence`,
    [ncaa_team_id, academic_year]
  );
  return rows;
}

// ─── Matchup query ─────────────────────────────────────────────────────────

async function getMatchupPlays(team_a_id, team_b_id, academic_year) {
  // Return all plays from games where team_a and team_b faced each other.
  // When both teams scraped the same contest (same contest_id), we deduplicate:
  // prefer the home-team's game record (is_away=false) since home teams are less
  // likely to have their is_away flag flipped.  For NULL contest_ids, treat each
  // game record independently (they can't be matched to a partner).
  const { rows } = await pool.query(`
    WITH candidate_games AS (
      SELECT g.id, g.ncaa_team_id, g.opponent_team_id, g.contest_id,
             g.game_date, g.is_away,
             -- rank within each contest: home game (is_away=false) wins; break ties by id
             ROW_NUMBER() OVER (
               PARTITION BY COALESCE(g.contest_id::text, 'solo_' || g.id::text)
               ORDER BY g.is_away ASC, g.id ASC
             ) AS rn
      FROM ncaa_games g
      WHERE g.academic_year = $3
        AND g.ncaa_team_id IN ($1, $2)
        AND (
          -- Case 1: opponent_team_id explicitly set
          g.opponent_team_id IN ($1, $2)
          -- Case 2: shared contest_id (opponent_team_id is often NULL)
          OR (
            g.contest_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM ncaa_games o
              WHERE o.contest_id = g.contest_id
                AND o.academic_year = $3
                AND o.ncaa_team_id = CASE WHEN g.ncaa_team_id = $1 THEN $2 ELSE $1 END
            )
          )
        )
    )
    SELECT p.*,
      cg.game_date, cg.ncaa_team_id AS game_team_id, cg.opponent_team_id, cg.is_away,
      -- opponent_team_id is often NULL; fall back to the other team from the query params
      CASE
        WHEN (p.half = 'top' AND cg.is_away = true ) OR (p.half = 'bot' AND cg.is_away = false)
          THEN cg.ncaa_team_id
        ELSE COALESCE(cg.opponent_team_id,
               CASE WHEN cg.ncaa_team_id = $1 THEN $2::bigint ELSE $1::bigint END)
      END AS batting_team_id,
      CASE
        WHEN (p.half = 'top' AND cg.is_away = true ) OR (p.half = 'bot' AND cg.is_away = false)
          THEN COALESCE(cg.opponent_team_id,
                 CASE WHEN cg.ncaa_team_id = $1 THEN $2::bigint ELSE $1::bigint END)
        ELSE cg.ncaa_team_id
      END AS pitching_team_id
    FROM ncaa_plays p
    JOIN candidate_games cg ON cg.id = p.game_id AND cg.rn = 1
    WHERE p.batter_name IS NOT NULL
    ORDER BY cg.game_date, p.id
  `, [team_a_id, team_b_id, academic_year]);
  return rows;
}

// ─── Summary query ─────────────────────────────────────────────────────────

async function getTeamSummary(ncaa_team_id, academic_year) {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE result='W') AS wins,
      COUNT(*) FILTER (WHERE result='L') AS losses,
      COUNT(*) FILTER (WHERE result='T') AS ties,
      COUNT(*) FILTER (WHERE pbp_scraped=TRUE) AS games_with_pbp,
      COUNT(*) AS total_games,
      SUM(our_score) AS total_runs_scored,
      SUM(opp_score) AS total_runs_allowed
    FROM ncaa_games
    WHERE ncaa_team_id=$1 AND academic_year=$2
  `, [ncaa_team_id, academic_year]);
  return rows[0];
}

// ─── H2H helpers ───────────────────────────────────────────────────────────

// Returns all game records from BOTH teams' perspectives for their head-to-head games.
// Matches by:
//   1. opponent_team_id (set when opponent was already in DB at scrape time), OR
//   2. shared contest_id (both teams scraped the same contest — works even when
//      opponent_team_id is NULL, which is the common case).
async function getH2HGames(teamA, teamB, year) {
  const { rows } = await pool.query(`
    SELECT g.*, nt.name AS opponent_name
    FROM ncaa_games g
    LEFT JOIN ncaa_teams nt ON nt.ncaa_team_id = g.opponent_team_id
    WHERE g.academic_year = $3
      AND g.ncaa_team_id IN ($1, $2)
      AND (
        -- Case 1: opponent_team_id explicitly links to the other team
        g.opponent_team_id IN ($1, $2)
        -- Case 2: the other team has a game record with the same contest_id
        OR (
          g.contest_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM ncaa_games o
            WHERE o.contest_id = g.contest_id
              AND o.academic_year = $3
              AND o.ncaa_team_id = CASE WHEN g.ncaa_team_id = $1 THEN $2 ELSE $1 END
          )
        )
      )
    ORDER BY g.game_date, g.id
  `, [teamA, teamB, year]);
  return rows;
}

// Delete plays and clear pbp_scraped for a specific list of game IDs.
async function resetPbpForGames(gameIds) {
  if (!gameIds || !gameIds.length) return 0;
  await pool.query('DELETE FROM ncaa_plays WHERE game_id = ANY($1)', [gameIds]);
  const { rowCount } = await pool.query(
    'UPDATE ncaa_games SET pbp_scraped=FALSE, pbp_scraped_at=NULL WHERE id = ANY($1)',
    [gameIds]
  );
  return rowCount;
}

module.exports = {
  pool,
  initSchema,
  // teams
  upsertTeam, getTeam, deleteTeam, searchTeams, getAllTeams, markTeamScraped,
  // seasons
  upsertSeason, markSeasonScraped,
  // games
  upsertGame, getGames, getGame, markGamePbpScraped, getUnscrapedGames,
  // players
  upsertPlayer, getPlayers,
  // plays
  insertPlays, getPlays, resetPbpScraped, resetPbpForGames,
  getSeasonPlays, getPlaysNeedingResolution, updatePlayBatter,
  updatePlayPitcher, getAllPlaysForSeason,
  // stats
  upsertBattingStats, upsertPitchingStats, getBattingStats, getPitchingStats,
  // matchup
  getMatchupPlays,
  // h2h
  getH2HGames,
  // summary
  getTeamSummary,
};