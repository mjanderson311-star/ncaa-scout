'use strict';
// Load .env file if it exists (optional — lets you put credentials in a .env file)
try { require('dotenv').config(); } catch(e) { /* dotenv not installed — that's fine */ }

const express  = require('express');
const path     = require('path');
const db       = require('./db');
const scraper  = require('./scraper');
const { closeBrowser } = require('./browserFetch');

// Graceful shutdown — close Playwright browser on Ctrl+C or nodemon restart
process.on('SIGINT',  () => { closeBrowser().finally(() => process.exit(0)); });
process.on('SIGTERM', () => { closeBrowser().finally(() => process.exit(0)); });

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Redirect bare root to the app
app.get('/', (_req, res) => res.redirect('/app.html'));

// ─── Admin auth ─────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'scout2025';
const adminTokens = new Set();  // in-memory valid tokens

function randomToken() {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

// POST /api/admin/login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    const token = randomToken();
    adminTokens.add(token);
    return res.json({ ok: true, token });
  }
  res.status(401).json({ ok: false, error: 'Wrong password' });
});

// Middleware for admin-only routes
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token && adminTokens.has(token)) return next();
  res.status(403).json({ error: 'Admin access required' });
}

// ─── SSE helper ────────────────────────────────────────────────────────────
// Active scrape jobs: jobId → { events: [], clients: [res], done: bool }
const jobs = new Map();
let nextJobId = 1;

function createJob() {
  const id = String(nextJobId++);
  jobs.set(id, { events: [], clients: [], done: false, result: null });
  return id;
}

function jobEmit(jobId, event) {
  const job = jobs.get(jobId);
  if (!job) return;
  const msg = `data: ${JSON.stringify(event)}\n\n`;
  job.events.push(msg);
  job.clients.forEach(res => res.write(msg));
  if (event.type === 'done' || event.type === 'error_fatal') {
    job.done = true;
    job.result = event;
    // Close SSE streams after a short delay
    setTimeout(() => {
      job.clients.forEach(res => { try { res.end(); } catch(e){} });
      job.clients = [];
      // Clean up job after 5 minutes
      setTimeout(() => jobs.delete(jobId), 300000);
    }, 2000);
  }
}

// GET /api/jobs/:id/stream — SSE stream for live progress
app.get('/api/jobs/:id/stream', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Replay buffered events for reconnecting clients
  job.events.forEach(msg => res.write(msg));

  if (job.done) { res.end(); return; }

  job.clients.push(res);
  req.on('close', () => {
    job.clients = job.clients.filter(c => c !== res);
  });
});

// ─── Team endpoints ─────────────────────────────────────────────────────────

// GET /api/teams — all teams in DB
app.get('/api/teams', async (req, res) => {
  try {
    const teams = await db.getAllTeams();
    res.json(teams);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/teams/lookup — parse a stats.ncaa.org URL/ID, upsert team, return it
app.post('/api/teams/lookup', requireAdmin, async (req, res) => {
  try {
    const { url, name, division } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    const parsed = scraper.lookupTeamByUrl(url);
    const team = await db.upsertTeam({
      ncaa_team_id: parsed.ncaa_team_id,
      name:         name.trim(),
      division:     division ? String(division) : '2',
      sport_code:   parsed.sport_code,
      base_url:     parsed.base_url,
    });
    res.json([team]);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/teams/search?q= — search NCAA teams by name
app.get('/api/teams/search', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q is required' });
    const teams = await scraper.searchNcaaTeams(q);
    res.json(teams);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/ncaa/all-teams?division=2 — full team list from NCAA (cached 1 hr)
// Scrapes the national rankings page to get every team for a division.
// No DB upsert — read-only. Used to populate the team-picker dropdown.
let _allTeamsCache = { division: null, data: [], at: 0 };
const ALL_TEAMS_TTL = 60 * 60 * 1000; // 1 hour

app.get('/api/ncaa/all-teams', async (req, res) => {
  try {
    const division = Number(req.query.division || 2);
    const now = Date.now();
    if (_allTeamsCache.division === division && now - _allTeamsCache.at < ALL_TEAMS_TTL && _allTeamsCache.data.length > 0) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(_allTeamsCache.data);
    }
    const teams = await scraper.fetchAllTeamsRaw(division);
    _allTeamsCache = { division, data: teams, at: now };
    res.setHeader('X-Cache', 'MISS');
    res.json(teams);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/team/:id — single team from DB
app.get('/api/team/:id', async (req, res) => {
  try {
    const team = await db.getTeam(Number(req.params.id));
    if (!team) return res.status(404).json({ error: 'Team not found' });
    res.json(team);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/teams/:id — remove team + all related data
app.delete('/api/teams/:id', requireAdmin, async (req, res) => {
  try {
    await db.deleteTeam(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Scrape endpoints ────────────────────────────────────────────────────────

// POST /api/scrape/team/:team_id — full team scrape (schedule + roster + PBP + stats)
app.post('/api/scrape/team/:team_id', requireAdmin, async (req, res) => {
  try {
    const { academic_year, name_override, skip_pbp } = req.body;
    if (!academic_year) return res.status(400).json({ error: 'academic_year required' });
    const jobId = createJob();
    res.json({ jobId });
    const emit = (ev) => jobEmit(jobId, ev);
    await scraper.scrapeTeam({
      ncaa_team_id:  Number(req.params.team_id),
      academic_year: Number(academic_year),
      skip_pbp:      skip_pbp === true || skip_pbp === 'true',
      name_override: name_override || null,
    }, emit);
    jobEmit(jobId, { type: 'done', message: 'Scrape complete' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/scrape/pbp/:game_id — scrape PBP for a single game
app.post('/api/scrape/pbp/:game_id', requireAdmin, async (req, res) => {
  try {
    const game = await db.getGame(Number(req.params.game_id));
    if (!game) return res.status(404).json({ error: 'Game not found' });
    const jobId = createJob();
    res.json({ jobId });
    const emit = (ev) => jobEmit(jobId, ev);
    await scraper.scrapePbp(game, emit);
    jobEmit(jobId, { type: 'done', message: 'PBP scrape complete' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/scrape/h2h-pbp — scrape PBP only for games between two specific teams
// Body: { team_a, team_b, academic_year }
// Streams SSE progress, then runs resolve-names + resolve-pitchers for both teams.
app.post('/api/scrape/h2h-pbp', requireAdmin, async (req, res) => {
  try {
    const { team_a, team_b, academic_year } = req.body;
    if (!team_a || !team_b || !academic_year) {
      return res.status(400).json({ error: 'team_a, team_b, and academic_year are required' });
    }

    const jobId = createJob();
    res.json({ jobId });
    const emit = (ev) => jobEmit(jobId, ev);

    // 1. Find all game records (both perspectives) for this H2H matchup
    const games = await db.getH2HGames(Number(team_a), Number(team_b), Number(academic_year));
    if (!games.length) {
      jobEmit(jobId, { type: 'done', message: 'No head-to-head games found for these teams / year.' });
      return;
    }
    emit({ type: 'info', message: `Found ${games.length} game record(s) for H2H matchup — resetting PBP…` });

    // 2. Reset plays and pbp_scraped for just those games
    const gameIds = games.map(g => g.id);
    await db.resetPbpForGames(gameIds);
    emit({ type: 'info', message: `Reset PBP for ${gameIds.length} game record(s). Starting re-scrape…` });

    // 3. Re-scrape PBP for each game record
    let done = 0;
    for (const game of games) {
      emit({ type: 'progress', done, total: games.length,
             message: `Scraping: ${game.game_date ? game.game_date.toISOString().slice(0,10) : '?'} — ${game.opponent_name || game.opponent_team_id}` });
      try {
        await scraper.scrapePbp(game, emit);
      } catch (e) {
        emit({ type: 'warn', message: `Error scraping game ${game.id}: ${e.message}` });
      }
      done++;
    }

    // 4. Resolve names + pitchers for both teams
    emit({ type: 'info', message: 'Resolving batter names for both teams…' });
    await scraper.resolvePlayBatterIds(Number(team_a), Number(academic_year), emit).catch(e =>
      emit({ type: 'warn', message: `resolve-names team_a: ${e.message}` })
    );
    await scraper.resolvePlayBatterIds(Number(team_b), Number(academic_year), emit).catch(e =>
      emit({ type: 'warn', message: `resolve-names team_b: ${e.message}` })
    );

    emit({ type: 'info', message: 'Resolving pitcher names for both teams…' });
    await scraper.resolvePlayPitcherNames(Number(team_a), Number(academic_year), emit).catch(e =>
      emit({ type: 'warn', message: `resolve-pitchers team_a: ${e.message}` })
    );
    await scraper.resolvePlayPitcherNames(Number(team_b), Number(academic_year), emit).catch(e =>
      emit({ type: 'warn', message: `resolve-pitchers team_b: ${e.message}` })
    );

    jobEmit(jobId, { type: 'done', message: `H2H PBP re-scrape complete — ${done} game record(s) processed.` });
  } catch (e) {
    console.error('/api/scrape/h2h-pbp', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/scrape/reset-pbp/:team_id — delete all plays and clear pbp_scraped flags so PBP can be re-scraped
app.post('/api/scrape/reset-pbp/:team_id', requireAdmin, async (req, res) => {
  try {
    const { academic_year } = req.body;
    if (!academic_year) return res.status(400).json({ error: 'academic_year required' });
    const count = await db.resetPbpScraped(Number(req.params.team_id), Number(academic_year));
    res.json({ message: `Reset ${count} games — ready to re-scrape PBP` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/scrape/stats/:team_id — scrape batting + pitching season stats only
app.post('/api/scrape/stats/:team_id', requireAdmin, async (req, res) => {
  try {
    const { academic_year } = req.body;
    if (!academic_year) return res.status(400).json({ error: 'academic_year required' });
    const jobId = createJob();
    res.json({ jobId });
    const emit = (ev) => jobEmit(jobId, ev);
    const result = await scraper.scrapeSeasonToDateStats(Number(req.params.team_id), Number(academic_year), emit);
    jobEmit(jobId, { type: 'done', message: `Stats: ${result.batting.length} batting, ${result.pitching.length} pitching rows saved` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/scrape/resolve-pitchers/:team_id — backfill pitcher_name for existing plays
app.post('/api/scrape/resolve-pitchers/:team_id', requireAdmin, async (req, res) => {
  try {
    const { academic_year } = req.body;
    if (!academic_year) return res.status(400).json({ error: 'academic_year required' });
    const jobId = createJob();
    res.json({ jobId });
    const emit = (ev) => jobEmit(jobId, ev);
    const result = await scraper.resolvePlayPitcherNames(Number(req.params.team_id), Number(academic_year), emit);
    jobEmit(jobId, { type: 'done', message: `Assigned pitcher names to ${result.assigned} plays out of ${result.total} total` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/scrape/situational/:team_id — scrape situational hitting for all games of a team/year
app.post('/api/scrape/situational/:team_id', requireAdmin, async (req, res) => {
  try {
    const { academic_year } = req.body;
    if (!academic_year) return res.status(400).json({ error: 'academic_year required' });
    const jobId = createJob();
    res.json({ jobId });
    const emit = (ev) => jobEmit(jobId, ev);
    await scraper.scrapeSituationalHitting(Number(req.params.team_id), Number(academic_year), emit);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/scout/:team_id/:year/situational — per-game situational hitting rows
app.get('/api/scout/:team_id/:year/situational', async (req, res) => {
  try {
    const rows = await db.getSituationalHitting(Number(req.params.team_id), Number(req.params.year));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/scout/:team_id/:year/situational/rollup — season totals per player
app.get('/api/scout/:team_id/:year/situational/rollup', async (req, res) => {
  try {
    const rows = await db.getSituationalHittingRollup(Number(req.params.team_id), Number(req.params.year));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/debug/matchup-raw?team_a=&team_b=&year= — diagnose batting attribution in matchup
app.get('/api/debug/matchup-raw', async (req, res) => {
  try {
    const { team_a, team_b, year } = req.query;
    if (!team_a || !team_b)
      return res.status(400).json({ error: 'team_a and team_b required' });

    // 1. Show ALL games for each team (no year or opponent filter) so we can see what's stored
    const { rows: teamAGames } = await db.pool.query(`
      SELECT id, ncaa_team_id, opponent_team_id, contest_id, game_date, academic_year, is_away,
             our_score, opp_score, result, pbp_scraped,
             (SELECT COUNT(*) FROM ncaa_plays WHERE game_id=g.id) AS play_count,
             (SELECT COUNT(*) FROM ncaa_plays WHERE game_id=g.id AND batter_name IS NOT NULL) AS named_count
      FROM ncaa_games g
      WHERE ncaa_team_id=$1
      ORDER BY game_date, id
    `, [Number(team_a)]);

    const { rows: teamBGames } = await db.pool.query(`
      SELECT id, ncaa_team_id, opponent_team_id, contest_id, game_date, academic_year, is_away,
             our_score, opp_score, result, pbp_scraped,
             (SELECT COUNT(*) FROM ncaa_plays WHERE game_id=g.id) AS play_count,
             (SELECT COUNT(*) FROM ncaa_plays WHERE game_id=g.id AND batter_name IS NOT NULL) AS named_count
      FROM ncaa_games g
      WHERE ncaa_team_id=$1
      ORDER BY game_date, id
    `, [Number(team_b)]);

    // 2. Games linking the two teams (with or without year filter)
    const yearCond = year ? 'AND g.academic_year=$3' : '';
    const yearParam = year ? [Number(team_a), Number(team_b), Number(year)] : [Number(team_a), Number(team_b)];
    const { rows: linkedGames } = await db.pool.query(`
      SELECT g.id, g.ncaa_team_id, g.opponent_team_id, g.contest_id, g.game_date, g.academic_year,
             g.is_away, g.our_score, g.opp_score, g.result, g.pbp_scraped,
             (SELECT COUNT(*) FROM ncaa_plays WHERE game_id=g.id) AS play_count,
             (SELECT COUNT(*) FROM ncaa_plays WHERE game_id=g.id AND batter_name IS NOT NULL) AS named_count
      FROM ncaa_games g
      WHERE (
        (g.ncaa_team_id=$1 AND g.opponent_team_id=$2)
        OR (g.ncaa_team_id=$2 AND g.opponent_team_id=$1)
      ) ${yearCond}
      ORDER BY g.game_date, g.id
    `, yearParam);

    // 3. For linked games, sample plays with batting attribution
    const gameSamples = [];
    for (const g of linkedGames) {
      const { rows: plays } = await db.pool.query(`
        SELECT p.id, p.inning, p.half, p.sequence, p.batter_name, p.play_type,
               p.raw_text,
               CASE
                 WHEN (p.half='top' AND $2=true) OR (p.half='bot' AND $2=false)
                   THEN $3::bigint
                 ELSE $4::bigint
               END AS computed_batting_team_id
        FROM ncaa_plays p
        WHERE p.game_id=$1
        ORDER BY p.inning, CASE WHEN p.half='top' THEN 0 ELSE 1 END, p.sequence
        LIMIT 20
      `, [g.id, g.is_away, g.ncaa_team_id, g.opponent_team_id]);
      gameSamples.push({ game: g, sample_plays: plays });
    }

    // 4. Half-attribution counts for linked games
    const { rows: halfCounts } = await db.pool.query(`
      SELECT g.ncaa_team_id AS game_team_id, g.opponent_team_id, g.is_away, p.half,
             COUNT(*) AS play_count,
             COUNT(p.batter_name) AS named_count,
             CASE
               WHEN (p.half='top' AND g.is_away=true) OR (p.half='bot' AND g.is_away=false)
                 THEN g.ncaa_team_id
               ELSE g.opponent_team_id
             END AS computed_batting_team_id
      FROM ncaa_plays p
      JOIN ncaa_games g ON g.id=p.game_id
      WHERE (
        (g.ncaa_team_id=$1 AND g.opponent_team_id=$2)
        OR (g.ncaa_team_id=$2 AND g.opponent_team_id=$1)
      ) ${yearCond}
      GROUP BY g.ncaa_team_id, g.opponent_team_id, g.is_away, p.half,
               CASE
                 WHEN (p.half='top' AND g.is_away=true) OR (p.half='bot' AND g.is_away=false)
                   THEN g.ncaa_team_id
                 ELSE g.opponent_team_id
               END
      ORDER BY g.ncaa_team_id, p.half
    `, yearParam);

    res.json({
      team_a_all_games: teamAGames,
      team_b_all_games: teamBGames,
      linked_games: linkedGames,
      half_attribution_counts: halfCounts,
      game_samples: gameSamples,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/debug/nonbatter-plays/:team_id?year= — sample non-batting play text (for diagnosing pitcher detection)
app.get('/api/debug/nonbatter-plays/:team_id', async (req, res) => {
  try {
    const { year } = req.query;
    const { rows } = await db.pool.query(
      `SELECT p.id, p.raw_text, p.play_type, p.half, p.inning, p.pitcher_name, g.game_date
       FROM ncaa_plays p
       JOIN ncaa_games g ON g.id = p.game_id
       WHERE g.ncaa_team_id = $1 AND g.academic_year = $2
         AND p.batter_name IS NULL
         AND p.raw_text IS NOT NULL
         AND p.raw_text != ''
       ORDER BY g.game_date, p.id
       LIMIT 60`,
      [Number(req.params.team_id), Number(year)]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/scrape/resolve-names/:team_id — backfill batter_name + batter_player_id for existing plays
app.post('/api/scrape/resolve-names/:team_id', requireAdmin, async (req, res) => {
  try {
    const { academic_year } = req.body;
    if (!academic_year) return res.status(400).json({ error: 'academic_year required' });
    const jobId = createJob();
    res.json({ jobId });
    const emit = (ev) => jobEmit(jobId, ev);
    const result = await scraper.resolvePlayBatterIds(Number(req.params.team_id), Number(academic_year), emit);
    jobEmit(jobId, { type: 'done', message: `Resolved ${result.resolved} names (${result.matched} matched to IDs) across ${result.total} plays` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Scout data endpoints ──────────────────────────────────────────────────

// GET /api/scout/:team_id/:year/summary
app.get('/api/scout/:team_id/:year/summary', async (req, res) => {
  try {
    const { team_id, year } = req.params;
    const [team, summary, players] = await Promise.all([
      db.getTeam(Number(team_id)),
      db.getTeamSummary(Number(team_id), Number(year)),
      db.getPlayers(Number(team_id), Number(year)),
    ]);
    res.json({ team, summary, players });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/scout/:team_id/:year/games
app.get('/api/scout/:team_id/:year/games', async (req, res) => {
  try {
    const games = await db.getGames(Number(req.params.team_id), Number(req.params.year));
    res.json(games);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/scout/game/:game_id/plays
app.get('/api/scout/game/:game_id/plays', async (req, res) => {
  try {
    const [game, plays] = await Promise.all([
      db.getGame(Number(req.params.game_id)),
      db.getPlays(Number(req.params.game_id)),
    ]);
    res.json({ game, plays });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/scout/:team_id/:year/players
app.get('/api/scout/:team_id/:year/players', async (req, res) => {
  try {
    const players = await db.getPlayers(Number(req.params.team_id), Number(req.params.year));
    res.json(players);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/scout/:team_id/:year/plays — all plays for a team/season
app.get('/api/scout/:team_id/:year/plays', async (req, res) => {
  try {
    const plays = await db.getSeasonPlays(Number(req.params.team_id), Number(req.params.year));
    res.json(plays);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/scout/:team_id/:year/batting
app.get('/api/scout/:team_id/:year/batting', async (req, res) => {
  try {
    const stats = await db.getBattingStats(Number(req.params.team_id), Number(req.params.year));
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/scout/:team_id/:year/pitching
app.get('/api/scout/:team_id/:year/pitching', async (req, res) => {
  try {
    const stats = await db.getPitchingStats(Number(req.params.team_id), Number(req.params.year));
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Matchup endpoint ───────────────────────────────────────────────────────

// GET /api/matchup?team_a=:id&team_b=:id&year=:year
app.get('/api/matchup', async (req, res) => {
  try {
    const { team_a, team_b, year } = req.query;
    if (!team_a || !team_b || !year)
      return res.status(400).json({ error: 'team_a, team_b, and year are required' });
    const [teamA, teamB, plays] = await Promise.all([
      db.getTeam(Number(team_a)),
      db.getTeam(Number(team_b)),
      db.getMatchupPlays(Number(team_a), Number(team_b), Number(year)),
    ]);
    res.json({ teamA, teamB, plays });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Start server ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`ncaa-scout server running on http://localhost:${PORT}`);
  db.initSchema()
    .then(() => console.log('DB schema ready'))
    .catch(e => console.error('DB init error:', e.message));
});
