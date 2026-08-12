'use strict';
/**
 * ncaa-scout scraper
 * Targets: stats.ncaa.org  (publicly accessible, no login)
 * Run from a local machine — datacenter IPs may be blocked.
 *
 * stats.ncaa.org is a JavaScript-rendered SPA — static HTTP fetches return
 * an empty shell. We use Playwright (headless Chrome) to get fully-rendered HTML.
 */

const fetch        = require('node-fetch');
const cheerio      = require('cheerio');
const db           = require('./db');
const { fetchHTMLWithBrowser, closeBrowser } = require('./browserFetch');

const BASE    = 'https://stats.ncaa.org';
const SPORT   = 'MBA';   // Men's Baseball

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Delay between requests (ms) — be polite to NCAA servers
const DELAY_MS = 600;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── HTML fetcher — uses headless Chrome via Playwright ───────────────────
// stats.ncaa.org is a JS-rendered SPA; node-fetch returns an empty shell.
async function fetchHTML(url, opts = {}) {
  console.log('[scraper] fetchHTML:', url);
  return fetchHTMLWithBrowser(url, opts);
}

// ─── JSON fetcher — node-fetch is fine for direct JSON API calls ──────────
async function fetchJSON(url) {
  console.log('[scraper] fetchJSON:', url);
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'Referer': BASE,
    },
    timeout: 15000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ─── Season IDs ────────────────────────────────────────────────────────────
// GET /game_upload/seasons?sport_code=MBA&division=2
// Returns array of {season_id, academic_year, division, ...}
// If that 403s, we extract the season_id from the team schedule page itself.

async function fetchSeasonList(division = 2) {
  const url = `${BASE}/game_upload/seasons?sport_code=${SPORT}&division=${division}`;
  const data = await fetchJSON(url);
  // data is array of objects; look for keys: season_id / id, academic_year / year
  return data.map(s => ({
    season_id:     s.season_id || s.id || s.Season_Id,
    academic_year: s.academic_year || s.year || s.Year,
    division:      String(s.division || s.Division || division),
  })).filter(s => s.season_id && s.academic_year);
}

let _seasonCache = {};

// Extract season_id from a team schedule HTML page
// The select dropdown for year has options with value = game_sport_year_ctl_id
function extractSeasonIdFromHtml(html, wantedYear) {
  const $ = cheerio.load(html);
  let found = null;
  // Look for <select> with name or id matching "year_ctl" or "game_sport_year_ctl_id"
  $('select').each((_i, sel) => {
    const name = ($(sel).attr('name') || $(sel).attr('id') || '').toLowerCase();
    if (!name.includes('year') && !name.includes('season') && !name.includes('ctl')) return;
    $(sel).find('option').each((_j, opt) => {
      const txt  = $(opt).text().trim();    // e.g. "2024-25" or "2026"
      const val  = $(opt).attr('value');    // numeric season_id
      if (!val || isNaN(Number(val))) return;
      // Match academic year: "2026" → 2025-26, or "2025-26"
      const yearMatch = txt.match(/(\d{4})/g);
      if (!yearMatch) return;
      const years = yearMatch.map(Number);
      if (years.includes(wantedYear) || years.includes(wantedYear - 1)) {
        found = { season_id: Number(val), academic_year: wantedYear };
      }
    });
  });
  // Also check links: ?game_sport_year_ctl_id=12345
  if (!found) {
    const m = html.match(/game_sport_year_ctl_id[="](\d+)/);
    if (m) found = { season_id: Number(m[1]), academic_year: wantedYear };
  }
  return found;
}

async function getSeasonId(academic_year, division = 2) {
  const key = `${academic_year}_${division}`;
  if (_seasonCache[key]) return _seasonCache[key];
  try {
    const list = await fetchSeasonList(division);
    for (const s of list) { _seasonCache[`${s.academic_year}_${s.division}`] = s.season_id; }
    if (_seasonCache[key]) return _seasonCache[key];
  } catch (e) {
    // seasons endpoint 403'd — fall through to page-based extraction
  }
  throw new Error(`No season_id found for year=${academic_year} div=${division}`);
}

// ─── Team lookup by URL or ID ───────────────────────────────────────────────
// stats.ncaa.org blocks direct HTTP requests for many pages.
// Instead of scraping the team page, we just extract the numeric ID from the URL
// and create a placeholder record. The real name is updated when scraping starts.

function lookupTeamByUrl(urlOrId) {
  const s = String(urlOrId).trim();
  // Match the team ID: 5+ consecutive digits in a stats.ncaa.org URL or bare number
  const m = s.match(/teams\/(\d+)/i) || s.match(/^(\d{5,})$/);
  if (!m) throw new Error(`Could not find a team ID — expected a URL like https://stats.ncaa.org/teams/615122 or just the number`);
  const teamId = Number(m[1]);
  return {
    ncaa_team_id: teamId,
    name:         `Team ${teamId}`,   // updated when scraping the schedule
    short_name:   null,
    division:     null,               // caller fills in
    conference:   null,
    sport_code:   SPORT,
    base_url:     `${BASE}/teams/${teamId}`,
  };
}

// ─── Team name resolution during scraping ─────────────────────────────────
// Extracts the real team name from the rendered schedule page.
async function resolveTeamName(ncaa_team_id) {
  try {
    const html = await fetchHTML(`${BASE}/teams/${ncaa_team_id}`);
    const $ = cheerio.load(html);

    // NCAA team pages render the team name in the page heading — try several selectors
    let name =
      $('h1').first().text().trim() ||
      $('h2').first().text().trim() ||
      $('[class*="team-name"],[class*="teamname"],[class*="school-name"]').first().text().trim() ||
      $('title').text().split(/[|\-–|:]/)[0].trim();

    // Strip trailing year / sport qualifiers like "2025-26 Baseball"
    if (name) name = name.replace(/\s+\d{4}(-\d{2,4})?(\s+(Baseball|Softball|Football|Basketball))?$/i, '').trim();

    // Conference: look for link or text near "conference" labels
    const conf =
      $('[class*="conf"],[class*="conference"]').first().text().trim() ||
      $('a[href*="conference"]').first().text().trim() || null;

    console.log(`[scraper] resolveTeamName: name="${name}" conf="${conf}"`);
    return { name: name || null, conference: conf || null };
  } catch (e) {
    console.warn('[scraper] resolveTeamName failed:', e.message);
    return { name: null, conference: null };
  }
}

// ─── Team search ──────────────────────────────────────────────────────────
// stats.ncaa.org returns 403 for most automated search/list endpoints.
// The recommended flow is: paste team URL → extract ID → scrape.
// We still expose this function so the server route exists.

async function searchNcaaTeams(query, division = 2) {
  // Return empty — search is handled by URL paste in the UI
  // (NCAA blocks automated search requests with 403)
  return [];
}

// ─── Full team list by division (no DB save) ──────────────────────────────
// Returns raw team data for a division without upserting to the DB.
// Used by the /api/ncaa/all-teams endpoint to power the team-picker dropdown.

async function fetchAllTeamsRaw(division = 2) {
  let teams = [];
  try {
    const year = new Date().getFullYear();
    const html = await fetchHTML(
      `${BASE}/rankings/national_team_statistics_ranking?sport_code=${SPORT}&division=${division}&academic_year=${year}`
    );
    const $ = cheerio.load(html);
    $('table tbody tr').each((_i, row) => {
      const link = $(row).find('a[href*="/teams/"]').first();
      if (!link.length) return;
      const m = (link.attr('href') || '').match(/\/teams\/(\d+)/);
      if (!m) return;
      const conf = $(row).find('td').eq(2).text().trim();
      teams.push({
        ncaa_team_id: Number(m[1]),
        name:         link.text().trim(),
        division:     String(division),
        conference:   conf || null,
        sport_code:   SPORT,
        base_url:     `${BASE}/teams/${m[1]}`,
      });
    });
  } catch(e) {
    console.error('[fetchAllTeamsRaw]', e.message);
  }
  return teams;
}

// ─── Full team list by division ────────────────────────────────────────────
// Scrapes the D2 standings/teams index page

async function fetchAllTeams(division = 2, emit = null) {
  const seasonId = await getSeasonId(new Date().getFullYear(), division).catch(() => null);
  // Try the association list JSON endpoint first
  const url = seasonId
    ? `${BASE}/teams/search.json?sport_code=${SPORT}&division=${division}&season_id=${seasonId}&limit=5000`
    : `${BASE}/teams/search.json?sport_code=${SPORT}&division=${division}&limit=5000`;

  emit && emit({ type: 'info', message: `Fetching team list for D${division}...` });
  let teams = [];
  try {
    teams = await searchNcaaTeams('', division);
  } catch (e) {
    emit && emit({ type: 'warn', message: `Team list error: ${e.message}` });
  }

  if (teams.length === 0) {
    // Scrape the associations HTML page
    emit && emit({ type: 'info', message: 'Falling back to HTML team list...' });
    const html = await fetchHTML(`${BASE}/rankings/national_team_statistics_ranking?sport_code=${SPORT}&division=${division}&academic_year=${new Date().getFullYear()}`);
    const $ = cheerio.load(html);
    $('table tbody tr').each((_i, row) => {
      const link = $(row).find('a[href*="/teams/"]').first();
      if (!link.length) return;
      const m = (link.attr('href') || '').match(/\/teams\/(\d+)/);
      if (!m) return;
      const conf = $(row).find('td').eq(2).text().trim();
      teams.push({
        ncaa_team_id: Number(m[1]),
        name:         link.text().trim(),
        division:     String(division),
        conference:   conf || null,
        sport_code:   SPORT,
        base_url:     `${BASE}/teams/${m[1]}`,
      });
    });
  }

  emit && emit({ type: 'info', message: `Found ${teams.length} teams` });
  for (const t of teams) {
    await db.upsertTeam(t);
  }
  return teams;
}

// ─── Team schedule ─────────────────────────────────────────────────────────
// GET /teams/:team_id  — shows season schedule
// or  /player/game_by_game?game_sport_year_ctl_id=...&org_id=...&stats_player_seq=...

async function scrapeTeamSchedule(ncaa_team_id, academic_year, division = 2, emit = null) {
  const team = await db.getTeam(ncaa_team_id);
  const teamName = team ? team.name : String(ncaa_team_id);

  // First load the default team page to discover available seasons and pick up cookies
  const baseUrl = `${BASE}/teams/${ncaa_team_id}`;
  emit && emit({ type: 'info', message: `Fetching schedule for ${teamName}...` });
  let html = await fetchHTML(baseUrl);

  // Try to extract the correct season_id for the requested year from the page
  const extracted = extractSeasonIdFromHtml(html, academic_year);
  if (extracted && extracted.season_id) {
    _seasonCache[`${academic_year}_${division}`] = extracted.season_id;
    emit && emit({ type: 'info', message: `Found season_id ${extracted.season_id} on schedule page` });
    // Re-fetch with explicit season_id so we get the right year's data
    const yearUrl = `${baseUrl}?game_sport_year_ctl_id=${extracted.season_id}`;
    try {
      html = await fetchHTML(yearUrl);
    } catch (e) {
      emit && emit({ type: 'warn', message: `Could not fetch year-specific schedule: ${e.message}` });
    }
  }

  const $ = cheerio.load(html);
  const games = [];

  // Debug: log page title and table count so we can tell if data is JS-rendered
  const pageTitle = $('title').text().trim();
  const tableCount = $('table').length;
  const allTableHeaders = [];
  $('table').each((_ti, t) => {
    const hdrs = $(t).find('thead th, thead td, tr:first-child th, tr:first-child td')
      .map((_i, el) => $(el).text().trim()).get().filter(h => h);
    if (hdrs.length) allTableHeaders.push(hdrs);
  });
  console.log(`[scraper] Schedule page: title="${pageTitle}" tables=${tableCount} headers=${JSON.stringify(allTableHeaders.slice(0,5))}`);
  emit && emit({ type: 'info', message: `Page: "${pageTitle}" — ${tableCount} table(s) found` });

  // Parse the schedule table
  // Stats.ncaa.org schedule table has headers: Date | Opponent | Score | Attendance
  $('table').each((_ti, table) => {
    const $table = $(table);
    const headers = $table.find('thead th, thead td').map((_i, el) => $(el).text().trim().toLowerCase()).get();
    if (!headers.some(h => h.includes('opponent') || h.includes('opp'))) return;

    const dateIdx  = headers.findIndex(h => h === 'date');
    const oppIdx   = headers.findIndex(h => h.includes('opponent') || h === 'opp');
    const scoreIdx = headers.findIndex(h => h === 'score' || h === 'result');

    let lastDate = null;

    $table.find('tbody tr').each((_ri, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;

      // Skip section header rows
      if ($(row).hasClass('heading') || cells.eq(0).attr('colspan')) return;

      const dateText = dateIdx >= 0 ? cells.eq(dateIdx).text().trim() : '';
      const oppCell  = oppIdx >= 0  ? cells.eq(oppIdx) : cells.eq(1);
      const scoreText = scoreIdx >= 0 ? cells.eq(scoreIdx).text().trim() : '';

      // Date carry-forward for doubleheaders
      if (dateText) lastDate = dateText;
      const gameDate = parseDate(lastDate, academic_year);

      // Opponent
      const oppLink = oppCell.find('a').first();
      const oppName = oppLink.length ? oppLink.text().trim() : oppCell.text().trim();
      const oppHref = (oppLink.attr('href') || '').trim();
      const oppTeamIdMatch = oppHref.match(/\/teams\/(\d+)/);
      const oppTeamId = oppTeamIdMatch ? Number(oppTeamIdMatch[1]) : null;

      // Location prefix: "at Holy Family" → away, "@Holy Family" or "@ Holy Family" → away
      const fullOppText = oppCell.text().trim();
      const isAway    = /^at\s/i.test(fullOppText) || /^@/.test(fullOppText);
      const isNeutral = /^vs\.?\s/i.test(fullOppText);

      // Score: "W, 6-4" or "L, 2-10" or "3-2 W"
      const { ourScore, oppScore, result } = parseScore(scoreText, isAway);

      // Contest link — several places to look
      let contestId = null;
      cells.each((_ci, cell) => {
        if (contestId) return;
        $(cell).find('a[href*="/contests/"]').each((_li, a) => {
          if (contestId) return;
          const m = ($(a).attr('href') || '').match(/\/contests\/(\d+)/);
          if (m) contestId = Number(m[1]);
        });
      });
      // Also check row-level links
      if (!contestId) {
        $(row).find('a[href*="/contests/"]').each((_li, a) => {
          if (contestId) return;
          const m = ($(a).attr('href') || '').match(/\/contests\/(\d+)/);
          if (m) contestId = Number(m[1]);
        });
      }

      if (!oppName || oppName.length < 2) return;

      games.push({
        ncaa_team_id,
        academic_year,
        contest_id:      contestId,
        game_date:       gameDate,
        opponent_name:   cleanOppName(oppName),
        opponent_team_id: oppTeamId,
        is_away:         isAway,
        is_neutral:      isNeutral,
        our_score:       ourScore,
        opp_score:       oppScore,
        result:          result,
        innings:         9,
        raw_result_text: scoreText,
        _rawDate:        lastDate || '',   // kept for dedup only, not saved to DB
      });
    });
  });

  emit && emit({ type: 'info', message: `Found ${games.length} games on schedule (pre-dedup)` });

  // Deduplicate games from the page before saving.
  // The NCAA schedule page often renders the same game in multiple tables (full schedule,
  // home-games section, etc.).  Games with a contest_id are deduplicated by the DB's
  // ON CONFLICT clause, but null-contest-id games (postponed/TBD) need client-side dedup.
  // Key: raw date text (preserves "(1)"/"(2)" doubleheader suffixes) + opponent + home/away.
  // That way two real doubleheader games on the same date stay as two rows.
  const nullContestSeen = new Map(); // key → game
  const deduped = [];
  for (const g of games) {
    if (g.contest_id) {
      deduped.push(g);
    } else {
      const key = `${g._rawDate}|${g.opponent_name}|${g.is_away}`;
      console.log(`[schedule-dedup] null-contest key="${key}" date="${g.game_date}" opp="${g.opponent_name}"`);
      if (!nullContestSeen.has(key)) {
        nullContestSeen.set(key, g);
        deduped.push(g);
      } else {
        console.log(`[schedule-dedup] → DROPPED duplicate`);
      }
    }
  }
  emit && emit({ type: 'info', message: `After dedup: ${deduped.length} unique games` });

  // Before saving, purge stale null-contest-id rows for this team+year.
  // Games without a contest link can't be deduped by ON CONFLICT (ncaa_team_id, contest_id)
  // because NULL != NULL in unique constraints — every re-scrape would add new rows.
  // Purging first and re-inserting is safe: these games have no PBP (scrapePbp skips them).
  await db.pool.query(
    `DELETE FROM ncaa_games WHERE ncaa_team_id = $1 AND academic_year = $2 AND contest_id IS NULL`,
    [ncaa_team_id, academic_year]
  );

  // Save to DB (use deduped list; strip the internal _rawDate field before upsert)
  const saved = [];
  for (const g of deduped) {
    const { _rawDate, ...gameRow } = g;
    const row = await db.upsertGame(gameRow);
    saved.push(row);
    await sleep(50);
  }

  return saved;
}

// ─── Play-by-play scraper ──────────────────────────────────────────────────
// GET /contests/:contest_id/play_by_play

async function scrapePbp(game, emit = null) {
  if (!game.contest_id) {
    emit && emit({ type: 'warn', message: `Game #${game.id} has no contest_id, skipping PBP` });
    return [];
  }

  const url = `${BASE}/contests/${game.contest_id}/play_by_play`;
  emit && emit({ type: 'info', message: `PBP: ${url}` });

  let html;
  try {
    // Wait specifically for the inning header rows, not just any table
    html = await fetchHTML(url, {
      waitForSelector: 'table',
      timeout: 45000,
    });
  } catch (e) {
    emit && emit({ type: 'error', message: `PBP fetch error: ${e.message}` });
    return [];
  }

  // Debug: log page structure so we can diagnose parser issues
  const $d = cheerio.load(html);
  const tableCount = $d('table').length;
  const allTables = [];
  $d('table').each((_i, t) => {
    const caption = $d(t).find('caption').text().trim();
    const hdrs = $d(t).find('thead th, thead td').map((_j, el) => $d(el).text().trim()).get();
    const tbodyRows = $d(t).find('tbody tr');
    const directRows = $d(t).find('tr');
    const rows = tbodyRows.length || directRows.length;
    const firstCells = ($d(t).find('tbody tr:first-child td, tr:first-child td')).map((_j, el) => $d(el).text().trim()).get();
    const secondCells = ($d(t).find('tbody tr:nth-child(2) td, tr:nth-child(2) td')).map((_j, el) => $d(el).text().trim()).get();
    allTables.push({ caption, hdrs, rows, firstCells: firstCells.slice(0,4), secondCells: secondCells.slice(0,4) });
  });
  console.log(`[scraper] PBP page tables (${tableCount}):`, JSON.stringify(allTables, null, 1));
  emit && emit({ type: 'info', message: `PBP page: ${tableCount} table(s). Structure:` });
  allTables.slice(0, 8).forEach((t, i) => {
    emit && emit({ type: 'info', message: `  [${i}] rows=${t.rows} hdrs=${JSON.stringify(t.hdrs)} r1=${JSON.stringify(t.firstCells)} r2=${JSON.stringify(t.secondCells)}` });
  });

  const plays = parsePbpHtml(html, game);

  if (plays.length > 0) {
    // ── Resolve batter names against rosters ───────────────────────────────
    try {
      const [ourPlayers, oppPlayers] = await Promise.all([
        db.getPlayers(game.ncaa_team_id, game.academic_year),
        game.opponent_team_id
          ? db.getPlayers(Number(game.opponent_team_id), game.academic_year)
          : Promise.resolve([]),
      ]);
      const ourIndex = buildRosterIndex(ourPlayers);
      const oppIndex = buildRosterIndex(oppPlayers);
      // is_away=true → our team is the visitor (bats in TOP half)
      const awayIndex = game.is_away ? ourIndex : oppIndex;
      const homeIndex = game.is_away ? oppIndex : ourIndex;
      let matched = 0;
      for (const play of plays) {
        const name = extractBatterName(play.raw_text);
        if (!name) continue;
        play.batter_name = name;
        const idx = play.half === 'top' ? awayIndex : homeIndex;
        const found = lookupInRoster(name, idx);
        if (found) { play.batter_player_id = found.ncaa_player_id; matched++; }
      }
      const named = plays.filter(p => p.batter_name).length;
      emit && emit({ type: 'info', message: `Batter names: ${named} extracted, ${matched} matched to roster` });
    } catch (e) {
      emit && emit({ type: 'warn', message: `Batter name resolution failed: ${e.message}` });
    }

    await db.insertPlays(game.id, plays);
    await db.markGamePbpScraped(game.id);
    emit && emit({ type: 'info', message: `Stored ${plays.length} plays for game ${game.id}` });
  } else {
    await db.markGamePbpScraped(game.id);
    emit && emit({ type: 'warn', message: `No plays found for game ${game.id} (contest ${game.contest_id})` });
  }

  return plays;
}

// ─── PBP text filters ──────────────────────────────────────────────────────
// These patterns identify text that is METADATA, not a play description.
const METADATA_PATTERNS = [
  // Game info labels
  /^attendance\s*:/i,
  /^capacity\s*:/i,
  /^location\s*:/i,
  /^site\s*:/i,
  /^weather\s*:/i,
  /^temperature\s*:/i,
  /^wind\s*:/i,
  /^officials?\s*:/i,
  /^umpires?\s*:/i,
  /^game\s+time\s*:/i,
  /^duration\s*:/i,
  /^start\s*:/i,
  // Page section headings / nav items (exact matches)
  /^(play\s+by\s+play|box\s+score|team\s+stats|individual\s+stats|situational\s+stats|line\s+score)$/i,
  /^(scoreboard|statistics|rankings?|national\s+rankings?|active\s+career\s+leaders?)$/i,
  /^(selection\s+rankings?|head\s+coaches?|players?)$/i,
  /^(terms\s+and\s+conditions|privacy\s+policy|contact\s+us)$/i,
  // Inning summary line: "R: 0, H: 1, E: 0, LOB: 2"
  /^R:\s*\d+,\s*H:\s*\d+/i,
  // Team season record: "Holy Family Tigers 0-1, Conf 0-0" or "0-1, Conf 0-0"
  /\d+-\d+,\s*Conf\s+\d+-\d+/i,
  // Date strings
  /^\d{1,2}\/\d{1,2}\/\d{4}/,
  /^\d{1,2}:\d{2}\s*(am|pm)$/i,
  // US city+state: "Morgantown, WV"
  /^[A-Za-z][A-Za-z\s.\-']+,\s*[A-Z]{2}$/,
  // Score lines
  /^final\s*:/i,
  /^\d+\s*[-–]\s*\d+$/,
  // Copyright
  /©/,
  // Long concatenated nav text (>80 chars of pure ASCII nav words, no play verbs)
];

// Words that appear in real play descriptions — used to avoid filtering subs/pinch-hit notes
const PLAY_VERB_RE = /\b(struck|grounded|flied|lined|popped|singled|doubled|tripled|homered|walked|reached|scored|advanced|stole|caught|picked|threw|bunt|sac|rbi|error|passed|wild|pinch\s+(hit|ran)|to\s+(p|c|1b|2b|3b|ss|lf|cf|rf)\s+for)\b/i;

function isMetadataText(text, teamNames = []) {
  const t = (text || '').trim();
  if (t.length < 6) return true;   // too short to be a real play
  if (METADATA_PATTERNS.some(re => re.test(t))) return true;
  // Filter exact team name matches (column headers like "Holy Family" or "Shepherd")
  if (teamNames.length && teamNames.some(n => n && t.toLowerCase() === n.toLowerCase())) return true;
  // Filter short (≤30 chars), all-words strings with no play verbs — likely nav/team labels
  if (t.length <= 30 && /^[A-Za-z\s.'-]+$/.test(t) && !PLAY_VERB_RE.test(t)) {
    // Only filter if it looks like a proper noun (each word capitalized) and no lower-case-start words
    if (/^([A-Z][A-Za-z.'-]*(\s|$))+$/.test(t)) return true;
  }
  return false;
}

function parsePbpHtml(html, game) {
  const $ = cheerio.load(html);
  const plays = [];
  let seq = 0;

  // Build a list of team name strings to filter out column headers like "Holy Family" / "Shepherd"
  const teamNames = [
    game.opponent_name,
    game.home_team_name,   // may be undefined — that's fine
  ].filter(Boolean);

  // Wrap isMetadataText to include team names
  const isMeta = (txt) => isMetadataText(txt, teamNames);

  function parseInningHeader(txt) {
    if (!txt) return null;
    const t = txt.trim();

    // Pattern 1: "Top of 1st" / "Bottom of the 3rd" / "Bottom 3rd inning" / "Top-1"
    // Handles optional "of" and optional "the" before the inning number.
    const m1 = t.match(/^(top|bottom|bot)[\s\-–]+(of[\s\-–]+(?:the[\s\-–]+)?)?(\d+)(st|nd|rd|th)?(\s+inning)?/i);
    if (m1) return { half: m1[1].toLowerCase().startsWith('bot') ? 'bot' : 'top', inning: parseInt(m1[3], 10) };

    // Pattern 2: "1st Inning - Top" / "3rd - Bottom" / "4th inning Top"
    const m2 = t.match(/^(\d+)(st|nd|rd|th)?[\s\-–]*(inning[\s\-–]*)?(top|bottom|bot)\b/i);
    if (m2) return { half: m2[4].toLowerCase().startsWith('bot') ? 'bot' : 'top', inning: parseInt(m2[1], 10) };

    // Pattern 3: "TOP 1" / "BOT 2" / "TOP 1st" / "TOP-1"
    const m3 = t.match(/^(top|bot(?:tom)?)[\s\-–]+(\d+)/i);
    if (m3) return { half: m3[1].toLowerCase().startsWith('bot') ? 'bot' : 'top', inning: parseInt(m3[2], 10) };

    // Pattern 4: "2 - Top" / "3 - Bottom"
    const m4 = t.match(/^(\d+)\s*[-–]\s*(top|bottom|bot)\b/i);
    if (m4) return { half: m4[2].toLowerCase().startsWith('bot') ? 'bot' : 'top', inning: parseInt(m4[1], 10) };

    // Pattern 5: "1 Top" / "3 Bottom" / "1st Top Half" (digit then half, no separator required)
    const m5 = t.match(/^(\d+)(st|nd|rd|th)?\s+(top|bottom|bot)\b/i);
    if (m5) return { half: m5[3].toLowerCase().startsWith('bot') ? 'bot' : 'top', inning: parseInt(m5[1], 10) };

    // Pattern 6: "Inning 3" / "Inning 3 - Top" / "Inning 3 Bottom" (must start with "Inning")
    const m6  = t.match(/^inning\s+(\d+)/i);
    const m6h = t.match(/\b(top|bottom|bot)\b/i);
    if (m6) return { half: m6h ? (m6h[1].toLowerCase().startsWith('bot') ? 'bot' : 'top') : 'top', inning: parseInt(m6[1], 10) };

    return null;
  }

  let currentInning = 0;
  let currentHalf   = 'top';

  // ── Strategy A: tables whose rows have 3 columns (away | home | play) ─────
  // This is the canonical NCAA PBP table format.
  // We intentionally skip tables that look like they only have metadata.
  $('table').each((_ti, table) => {
    const $table = $(table);

    // Gather body rows — prefer tbody tr, fall back to all tr if no tbody
    const tbodyRows = $table.find('tbody tr');
    const bodyRows  = (tbodyRows.length > 0 ? tbodyRows : $table.find('tr')).toArray();
    if (bodyRows.length === 0) return;

    // Check caption / nearby heading for inning info
    const caption = $table.find('caption').text().trim();
    const capInning = parseInningHeader(caption);
    if (capInning) {
      currentHalf   = capInning.half;
      currentInning = capInning.inning;
    }

    // Also check the element immediately preceding this table for an inning heading
    const prevText = $table.prev('*').text().trim();
    const prevInning = parseInningHeader(prevText);
    if (prevInning) {
      currentHalf   = prevInning.half;
      currentInning = prevInning.inning;
    }

    // ── Detect side-by-side PBP format: thead has [TeamA | Score | TeamB] ──
    // NCAA sometimes renders each inning as one table with the away team's plays
    // in column 0 (top half) and the home team's plays in column 2 (bottom half).
    // The score appears as "X-Y" in column 1.  Each such table = one full inning.
    const theadHdrs = $table.find('thead th, thead td').map((_j, el) => $(el).text().trim()).get();
    const isSideBySide = theadHdrs.length === 3
                         && /^score$/i.test(theadHdrs[1])
                         && theadHdrs[0].length > 1
                         && theadHdrs[2].length > 1;
    if (isSideBySide) {
      // Each table is one inning; count tables to derive inning number.
      if (currentInning === 0) currentInning = 1;
      else currentInning++;
      currentHalf = 'top'; // reset at start of each inning (not strictly used below, but keep consistent)
    }

    // Auto-detect: if this looks like a score/PBP table (3+ cols, first two numeric)
    // and we haven't set an inning yet, assume inning 1 so plays aren't skipped.
    if (currentInning === 0) {
      const looksLikePbp = bodyRows.some(row => {
        const tds = $(row).find('td');
        return tds.length >= 3
          && /^\d+$/.test(tds.eq(0).text().trim())
          && /^\d+$/.test(tds.eq(1).text().trim())
          && tds.eq(2).text().trim().length > 3;
      });
      if (looksLikePbp) { currentInning = 1; currentHalf = 'top'; }
    }

    bodyRows.forEach(row => {
      // Check both td and th for colspan inning header rows
      const allCells = $(row).find('td, th');
      const cells    = $(row).find('td');
      if (allCells.length === 0) return;

      // ── colspan row = inning header (check th OR td) ──
      const firstCell = allCells.eq(0);
      const hasColspan = firstCell.attr('colspan') && parseInt(firstCell.attr('colspan'), 10) > 1;
      if (allCells.length === 1 || hasColspan) {
        // In side-by-side tables, inning is derived from table count — ignore inning headers
        // inside the table body to avoid resetting the counter mid-inning.
        if (!isSideBySide) {
          const hdr = firstCell.text().trim();
          const ih = parseInningHeader(hdr);
          if (ih) { currentHalf = ih.half; currentInning = ih.inning; }
        }
        return;  // never a play row
      }

      // ── Side-by-side table: col 0 = away (top half), col 2 = home (bot half) ──
      if (isSideBySide) {
        if (cells.length < 2 || currentInning === 0) return;
        const awayPlay  = cells.eq(0).text().trim();
        const scoreText = cells.eq(1).text().trim(); // e.g. "1-0"
        const homePlay  = cells.length >= 3 ? cells.eq(2).text().trim() : '';

        let awayScore = null, homeScore = null;
        const sm = scoreText.match(/^(\d+)-(\d+)$/);
        if (sm) { awayScore = parseInt(sm[1], 10); homeScore = parseInt(sm[2], 10); }

        if (awayPlay && !isMeta(awayPlay)) {
          const play = classifyPlay(awayPlay, currentInning, 'top', seq++);
          play.away_score_after = awayScore;
          play.home_score_after = homeScore;
          plays.push(play);
        }
        if (homePlay && !isMeta(homePlay)) {
          const play = classifyPlay(homePlay, currentInning, 'bot', seq++);
          play.away_score_after = awayScore;
          play.home_score_after = homeScore;
          plays.push(play);
        }
        return; // don't fall through to single-play extraction
      }

      // ── 3-column row: awayScore | homeScore | description ──
      let desc = '';
      let awayScore = null, homeScore = null;

      if (cells.length >= 3) {
        const c0 = cells.eq(0).text().trim();
        const c1 = cells.eq(1).text().trim();
        const c2 = cells.eq(2).text().trim();
        if (/^\d+$/.test(c0) && /^\d+$/.test(c1) && c2.length > 3) {
          awayScore = parseInt(c0, 10);
          homeScore = parseInt(c1, 10);
          desc = c2;
        } else if (!isMeta(cells.eq(cells.length - 1).text().trim())) {
          desc = cells.eq(cells.length - 1).text().trim();
        }
      } else if (cells.length === 2) {
        const c1 = cells.eq(1).text().trim();
        if (!isMeta(c1) && c1.length > 5) desc = c1;
      } else {
        desc = cells.eq(0).text().trim();
      }

      if (!desc || isMeta(desc) || currentInning === 0) return;

      const play = classifyPlay(desc, currentInning, currentHalf, seq++);
      play.away_score_after = awayScore;
      play.home_score_after = homeScore;
      plays.push(play);
    });
  });

  // ── Strategy B: div/section/element walk ─────────────────────────────────
  if (plays.length === 0) {
    if (currentInning === 0) { currentInning = 1; currentHalf = 'top'; }

    $('body *').each((_i, el) => {
      const $el = $(el);
      const tag = (el.tagName || '').toLowerCase();

      // Skip structural wrappers entirely
      if (['script','style','head','html','body','ul','ol','tbody','thead','table','tr'].includes(tag)) return;

      // For container elements (div, section, etc.): check ONLY direct text nodes for inning headers.
      // Using $el.text() on a <div> concatenates ALL descendant text, making inning header matching
      // impossible (e.g. "Bottom of 3rdAdam singled to left field. Josh scored.").
      // NCAA pages put half-inning labels like "Bottom of 3rd" as direct text inside a <div>.
      if (['div','section','article','main','nav','header','footer','aside'].includes(tag)) {
        let directText = '';
        $(el).contents().each((_j, node) => {
          if (node.type === 'text') directText += (node.data || '');
        });
        directText = directText.trim();
        if (directText && directText.length < 80) {
          const ih = parseInningHeader(directText);
          if (ih) { currentHalf = ih.half; currentInning = ih.inning; }
        }
        return; // never treat container text as a play — child elements are visited separately
      }

      // For all other elements (h1-h5, p, span, td, li, etc.): use full text
      const txt = $el.text().trim();
      if (!txt) return;

      // Check for inning header
      const ih = parseInningHeader(txt);
      if (ih) { currentHalf = ih.half; currentInning = ih.inning; return; }

      // Skip <th> cells — they're column headers (team names, etc.), not plays
      if (tag === 'th') return;

      if (isMeta(txt)) return;

      // Avoid double-counting: skip if a single child has identical text
      const children = $el.children().toArray();
      const childTexts = children.map(c => $(c).text().trim()).filter(t => t);
      if (childTexts.length === 1 && childTexts[0] === txt) return;

      const play = classifyPlay(txt, currentInning, currentHalf, seq++);
      plays.push(play);
    });
  }

  console.log(`[scraper] parsePbpHtml: ${plays.length} plays extracted (inning range: ${plays.length ? plays[0].inning : '-'} to ${plays.length ? plays[plays.length-1].inning : '-'})`);
  return plays;
}

// ─── Pitcher name extraction ───────────────────────────────────────────────

/**
 * Detect pitcher-change text in a raw PBP play string.
 * Returns the incoming pitcher's name, or null if this isn't a pitcher change.
 *
 * Actual NCAA PBP format (confirmed from debug data):
 *   "G. Conway to p."                  — first pitcher entering, no predecessor
 *   "C. Morris to p for G. Conway."    — pitcher change with predecessor listed
 *   "A. Matlack to p for C. Morris."
 *
 * Pattern: "NAME to p" where "p" is the position abbreviation for pitcher.
 * We distinguish "to p" from other position moves ("to rf", "to dh", "to 1b",
 * "to c", etc.) by requiring the token after "to" is exactly "p" (single letter).
 */
// Returns { name, predecessor } where predecessor may be null.
// "G. Conway to p."              → { name: 'G. Conway', predecessor: null }
// "C. Morris to p for G. Conway."→ { name: 'C. Morris', predecessor: 'G. Conway' }
function extractPitcherChange(rawText) {
  if (!rawText) return null;
  const t = rawText.trim();

  // Capture both the incoming pitcher (group 1) and optional predecessor (group 2)
  const m = t.match(/^([A-Za-z][A-Za-z'.\- ]{0,40}?)\s+to\s+p(?:\s+for\s+([A-Za-z][A-Za-z'.\- ]{1,40}?))?\s*[.,]?\s*$/i);
  if (!m) return null;

  const name = m[1].trim().replace(/[.,]+$/, '');

  // IMPORTANT: "Logan Mote grounded out to p." means the pitcher FIELDED the ball —
  // the lazy regex will capture "Logan Mote grounded out" as the "name" unless we reject it.
  // Any play containing a batter verb before "to p" is a fielding play, not a substitution.
  if (/\b(grounded?|lined?|flied?|fouled?|popped?|singled?|doubled?|tripled?|homered?|struck|walked?|reached|was\s+hit|hit\s+by|sacrificed?|bunted?|out\s+on|called\s+out)\b/i.test(name)) {
    return null;
  }

  // Real pitcher names are short (e.g. "G. Conway", "A. Matlack") — 4 words max.
  if (name.split(/\s+/).length > 4) return null;

  const predecessor = m[2] ? m[2].trim().replace(/[.,]+$/, '') : null;
  return { name, predecessor };
}

/**
 * Given an ordered array of plays for a SINGLE game (sorted by inning, half, sequence),
 * propagate pitcher names by tracking pitcher changes through the game.
 * Returns a Map of play.id → pitcher_name (only for plays that get a pitcher assigned).
 *
 * Logic:
 *   - We maintain a current pitcher for each "pitching side": the team pitching in top
 *     innings (home team) and the team pitching in bottom innings (away team).
 *   - When we see a pitcher-change play, we update the current pitcher for whichever
 *     side is currently pitching.
 *   - We assign the current pitcher to every play in that same half-inning.
 */
function assignPitchersToGame(gamePlays) {
  // pitcherForHalf: 'top' → current pitcher name when away team bats (home pitches)
  //                 'bot' → current pitcher name when home team bats (away pitches)
  const pitcherForHalf = { top: null, bot: null };
  const result = new Map(); // play.id → pitcher_name
  // Track plays that received no pitcher yet, so we can backfill when a predecessor appears.
  const unassigned = { top: [], bot: [] };

  for (const play of gamePlays) {
    const half = play.half || 'top';
    const change = extractPitcherChange(play.raw_text);
    if (change) {
      // If the current pitcher for this half was unknown, the predecessor name tells us
      // who was pitching before — backfill all previously unassigned plays in this half.
      if (pitcherForHalf[half] === null && change.predecessor) {
        for (const prevPlay of unassigned[half]) {
          result.set(prevPlay.id, change.predecessor);
        }
      }
      unassigned[half] = []; // reset; everything from here on uses change.name
      pitcherForHalf[half] = change.name;
      // don't assign to the change announcement itself
      continue;
    }
    if (pitcherForHalf[half]) {
      result.set(play.id, pitcherForHalf[half]);
    } else {
      // Pitcher not yet known for this half — stash for possible backfill
      unassigned[half].push(play);
    }
  }
  return result;
}

// ─── Batter name extraction + roster matching ──────────────────────────────

const BATTER_VERB_RE = /\b(grounded?|lined?|flied?|fouled?|popped?|singled?|doubled?|tripled?|homered?|struck\s+out|struck|walked?|reached\s+(on|first|base)|was\s+hit|hit\s+by|intentionally\s+walk|drew\s+a|sacrificed?|bunted?|out\s+on\s+a|called\s+out\s+on|swinging\s+strike|k(?:n?ocked)?\b)/i;

function extractBatterName(rawText) {
  if (!rawText) return null;
  const m = rawText.match(BATTER_VERB_RE);
  if (!m || m.index === 0) return null;
  let name = rawText.slice(0, m.index).trim().replace(/[,;.!\s]+$/, '').trim();
  if (!name || name.length < 2 || name.length > 60) return null;
  name = name.replace(/^(PH|PR|DH)\s+/i, '').trim();
  if (!/^[A-Za-z][A-Za-z' .\-]+$/.test(name)) return null;
  return name;
}

function buildRosterIndex(players) {
  const byFullName = new Map();
  const byLastName = new Map();
  const byAbbrev   = new Map();
  for (const p of players) {
    if (!p.name) continue;
    const name = p.name.trim();
    const nl   = name.toLowerCase();
    byFullName.set(nl, p);
    const parts = name.split(/\s+/);
    const last  = parts[parts.length - 1].toLowerCase();
    if (!byLastName.has(last)) byLastName.set(last, []);
    byLastName.get(last).push(p);
    if (parts.length >= 2) {
      const abbrev = `${parts[0][0].toUpperCase()}. ${parts.slice(1).join(' ')}`.toLowerCase();
      byAbbrev.set(abbrev, p);
      if (parts.length === 3) {
        const abbrev2 = `${parts[0][0].toUpperCase()}. ${parts[2]}`.toLowerCase();
        if (!byAbbrev.has(abbrev2)) byAbbrev.set(abbrev2, p);
      }
    }
  }
  return { byFullName, byLastName, byAbbrev };
}

function lookupInRoster(name, index) {
  if (!name || !index) return null;
  const nl = name.trim().toLowerCase();
  const full = index.byFullName.get(nl);
  if (full) return full;
  const abbr = index.byAbbrev.get(nl);
  if (abbr) return abbr;
  const parts = nl.split(/\s+/);
  const last  = parts[parts.length - 1];
  const byLast = index.byLastName.get(last);
  if (byLast && byLast.length === 1) return byLast[0];
  if (parts.length === 2) {
    for (const [key, p] of index.byFullName) {
      const kp = key.split(/\s+/);
      if (kp.length >= 2 && kp[0] === parts[0] && kp[kp.length - 1] === parts[1]) return p;
    }
  }
  return null;
}

// ─── Play classifier ───────────────────────────────────────────────────────

function classifyPlay(desc, inning, half, sequence) {
  const d = desc.toLowerCase();
  // Strip parenthetical pitch-count/sequence annotations like "(0-1 K)" or "(B S K)"
  // before testing bare-k strikeout, so "tripled to CF, RBI (0-1 K)" isn't misread as a K.
  const dClean = d.replace(/\([^)]*\)/g, '');
  let play_type = 'other';
  let runs_scored = 0;
  let rbi = 0;
  let is_scoring_play = false;

  if (/struck? out|strikeout|strike out/.test(d) || /\bk\b/.test(dClean))   play_type = 'strikeout';
  else if (/walk(ed)?|base on balls|\bbb\b/.test(d))                         play_type = 'walk';
  else if (/hit by pitch|hbp/.test(d))                                       play_type = 'hbp';
  else if (/home run|homered|hr\b/.test(d))                                  play_type = 'hr';
  else if (/triple[d\b]?/.test(d))                                           play_type = 'triple';
  else if (/double\s*play|\bgdp\b|\bdp\b/.test(d))                          play_type = 'out';
  else if (/double[d\b]?/.test(d))                                           play_type = 'double';
  else if (/single[d\b]?|singled/.test(d))                                   play_type = 'single';
  else if (/sac(rifice)?\s*(fly|bunt)|sf\b|sh\b/.test(d))                   play_type = 'sac';
  else if (/wild pitch|wp\b/.test(d))                                        play_type = 'wp';
  else if (/passed ball|pb\b/.test(d))                                       play_type = 'pb';
  else if (/balk/.test(d))                                                   play_type = 'balk';
  else if (/stole|stolen base|sb\b/.test(d))                                 play_type = 'steal';
  else if (/caught stealing|\bcs\b/.test(d))                                  play_type = 'caught_stealing';
  else if (/pick(ed)? off|pickoff/.test(d))                                  play_type = 'pickoff';
  else if (/error/.test(d))                                                  play_type = 'error';
  else if (/grounded? (into|out)|ground(ed)? (ball|out)|flied? out|popped? up|lined? out|fly(ing)? out|fouled? out/.test(d))
                                                                              play_type = 'out';
  else if (/out/.test(d))                                                    play_type = 'out';

  // Count runs scored — look for "scored" or multiple mentions
  const scoredMatches = d.match(/scored/g);
  if (scoredMatches) { runs_scored = scoredMatches.length; is_scoring_play = true; }

  // RBI extraction: "2 RBI", "RBI single", "1 run(s) batted in"
  const rbiMatch = d.match(/(\d+)\s*rbi/i) || d.match(/(\d+)\s*run[s]?\s*batted/i);
  if (rbiMatch) rbi = parseInt(rbiMatch[1], 10);
  else if (/\brbi\b/.test(d)) rbi = 1;

  return {
    inning, half, sequence,
    raw_text: desc, play_type,
    batter_name: null, pitcher_name: null,
    batter_player_id: null, pitcher_player_id: null,
    runners_on: null, outs_before: null,
    rbi, runs_scored, is_scoring_play,
    away_score_after: null, home_score_after: null,
  };
}

// ─── Roster scraper ────────────────────────────────────────────────────────
// GET /teams/:team_id/roster — player list with NCAA player IDs

async function scrapeRoster(ncaa_team_id, academic_year, emit = null) {
  const url = `${BASE}/teams/${ncaa_team_id}/roster`;
  emit && emit({ type: 'info', message: `Fetching roster for team ${ncaa_team_id}...` });
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);

  const players = [];

  $('table').each((_ti, table) => {
    const $table = $(table);
    const headers = $table.find('thead th').map((_i, el) => $(el).text().trim().toLowerCase()).get();
    if (!headers.some(h => h.includes('name') || h.includes('player'))) return;

    const nameIdx  = headers.findIndex(h => h.includes('name') || h.includes('player'));
    const numIdx   = headers.findIndex(h => h === '#' || h === 'no' || h === 'no.' || h === 'number');
    const posIdx   = headers.findIndex(h => h === 'pos' || h.includes('position'));
    const yearIdx  = headers.findIndex(h => h === 'yr' || h === 'year' || h === 'class');

    $table.find('tbody tr').each((_ri, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;

      const nameCell = nameIdx >= 0 ? cells.eq(nameIdx) : cells.eq(0);
      const link = nameCell.find('a[href*="/player/"]').first();
      if (!link.length) return;

      const playerHref = link.attr('href') || '';
      const pidMatch = playerHref.match(/\/player\/(\d+)/);
      if (!pidMatch) return;

      players.push({
        ncaa_team_id,
        ncaa_player_id: Number(pidMatch[1]),
        academic_year,
        name:           link.text().trim(),
        jersey_number:  numIdx >= 0 ? cells.eq(numIdx).text().trim() : null,
        position:       posIdx >= 0 ? cells.eq(posIdx).text().trim() : null,
        class_year:     yearIdx >= 0 ? cells.eq(yearIdx).text().trim() : null,
      });
    });
  });

  emit && emit({ type: 'info', message: `Found ${players.length} players` });
  for (const p of players) await db.upsertPlayer(p);
  return players;
}

// ─── Stats scraper (game-by-game batting) ──────────────────────────────────
// GET /player/game_by_game?game_sport_year_ctl_id=:season_id&org_id=:org_id&stats_player_seq=:player_id

async function scrapePlayerBattingStats(ncaa_team_id, ncaa_player_id, season_id, academic_year, emit = null) {
  // Need org_id for this endpoint — try to get from team record
  const team = await db.getTeam(ncaa_team_id);
  const orgId = team ? (team.org_id || '') : '';

  const url = `${BASE}/player/game_by_game?game_sport_year_ctl_id=${season_id}&org_id=${orgId}&stats_player_seq=${ncaa_player_id}`;
  let html;
  try {
    html = await fetchHTML(url);
  } catch (e) {
    emit && emit({ type: 'warn', message: `Stats fetch error player ${ncaa_player_id}: ${e.message}` });
    return null;
  }

  const $ = cheerio.load(html);
  // Look for totals row in the batting stats table
  let totals = null;
  $('table').each((_ti, table) => {
    if (totals) return;
    const $table = $(table);
    const headers = $table.find('thead th').map((_i, el) => $(el).text().trim().toLowerCase()).get();
    if (!headers.some(h => h === 'ab' || h === 'at bat' || h === 'at bats')) return;

    const idxOf = (keys) => {
      for (const k of keys) { const i = headers.indexOf(k); if (i >= 0) return i; }
      return -1;
    };
    const col = {
      g:   idxOf(['g','gp']), ab: idxOf(['ab','at bat']), r: idxOf(['r']), h: idxOf(['h']),
      '2b': idxOf(['2b']), '3b': idxOf(['3b']), hr: idxOf(['hr']),
      rbi: idxOf(['rbi']), bb: idxOf(['bb']), so: idxOf(['so','k']),
      sb:  idxOf(['sb']), cs: idxOf(['cs']), hbp: idxOf(['hp','hbp']),
      sf:  idxOf(['sf']), sh: idxOf(['sh','sac']),
      avg: idxOf(['avg','.avg']), obp: idxOf(['obp']), slg: idxOf(['slg']), ops: idxOf(['ops']),
    };

    // Find totals row (last tbody row or row labeled "Totals")
    let totRow = null;
    $table.find('tbody tr').each((_ri, row) => {
      const txt = $(row).find('td').eq(0).text().trim().toLowerCase();
      if (txt.includes('total') || txt.includes('career') || txt.includes('grand')) totRow = row;
    });
    if (!totRow) {
      const rows = $table.find('tbody tr').get();
      totRow = rows[rows.length - 1];
    }
    if (!totRow) return;

    const cells = $(totRow).find('td');
    const cv = (idx) => {
      if (idx < 0 || idx >= cells.length) return null;
      const v = cells.eq(idx).text().trim().replace(/[^0-9.\-]/g, '');
      return v === '' ? null : Number(v);
    };

    totals = {
      ncaa_team_id, ncaa_player_id, academic_year,
      g:       cv(col.g),   ab:     cv(col.ab), r:   cv(col.r),  h:   cv(col.h),
      doubles: cv(col['2b']), triples: cv(col['3b']), hr: cv(col.hr),
      rbi: cv(col.rbi), bb: cv(col.bb), so: cv(col.so),
      sb:  cv(col.sb),  cs: cv(col.cs), hbp: cv(col.hbp),
      sf:  cv(col.sf),  sh: cv(col.sh),
      avg: cv(col.avg), obp: cv(col.obp), slg: cv(col.slg), ops: cv(col.ops),
    };
  });

  if (totals) await db.upsertBattingStats(totals);
  return totals;
}

// ─── Main orchestration ────────────────────────────────────────────────────

/**
 * Full team scrape:
 *   1. Upsert team in DB
 *   2. Upsert season record
 *   3. Scrape schedule → upsert games
 *   4. Scrape roster → upsert players
 *   5. Scrape PBP for each game with a contest_id
 *
 * emit(event) — callback for progress events: { type: 'info'|'warn'|'error'|'progress', message, done, total }
 */
async function scrapeTeam({ ncaa_team_id, academic_year, division = 2, skip_pbp = false, name_override = null }, emit = null) {
  const log = (type, message) => { emit && emit({ type, message }); console.log(`[${type}] ${message}`); };

  try {
    log('info', `=== Scraping team ${ncaa_team_id} year ${academic_year} ===`);

    // 1. Ensure team record exists
    let team = await db.getTeam(ncaa_team_id);
    if (!team) {
      const initName = name_override || `Team ${ncaa_team_id}`;
      team = await db.upsertTeam({ ncaa_team_id, name: initName, division: String(division), sport_code: SPORT, base_url: `${BASE}/teams/${ncaa_team_id}` });
    }

    // If caller supplied a name override, always apply it first
    if (name_override && name_override.trim() && team.name !== name_override.trim()) {
      team = await db.upsertTeam({ ...team, name: name_override.trim() });
      log('info', `Team name set to: ${team.name}`);
    }

    // Try to resolve the real team name from NCAA (only if name is still a placeholder)
    if (!name_override && (!team.name || /^Team \d+$/.test(team.name))) {
      log('info', 'Resolving team name from NCAA...');
      const resolved = await resolveTeamName(ncaa_team_id);
      if (resolved.name && resolved.name !== 'NCAA Statistics') {
        team = await db.upsertTeam({ ...team, name: resolved.name, conference: resolved.conference || team.conference });
        log('info', `Team name: ${team.name}`);
      } else {
        log('warn', 'Could not resolve team name — update it using the rename field');
      }
    } else if (!name_override) {
      log('info', `Team: ${team.name}`);
    }

    // 2. Ensure season record
    let seasonId;
    try {
      seasonId = await getSeasonId(academic_year, division);
    } catch (e) {
      log('warn', `Could not resolve season_id: ${e.message}`);
    }
    if (seasonId) {
      await db.upsertSeason({ ncaa_team_id, academic_year, season_id: seasonId, division: String(division), sport_code: SPORT });
    }

    // 3. Schedule
    await sleep(DELAY_MS);
    const games = await scrapeTeamSchedule(ncaa_team_id, academic_year, division, emit);
    log('info', `Schedule: ${games.length} games saved`);

    // Always reset PBP so every scrape is a clean re-fetch (no stale data)
    if (!skip_pbp && games.length > 0) {
      await db.resetPbpScraped(ncaa_team_id, academic_year);
      log('info', 'PBP data cleared — will re-scrape all games');
    }

    // 4. Roster
    await sleep(DELAY_MS);
    let players = [];
    try {
      players = await scrapeRoster(ncaa_team_id, academic_year, emit);
      log('info', `Roster: ${players.length} players saved`);
    } catch (e) {
      log('warn', `Roster scrape failed: ${e.message}`);
    }

    // 5. PBP
    if (!skip_pbp) {
      const unscraped = await db.getUnscrapedGames(ncaa_team_id, academic_year);
      log('info', `PBP: ${unscraped.length} games to scrape`);
      let done = 0;
      for (const game of unscraped) {
        await sleep(DELAY_MS);
        await scrapePbp(game, emit);
        done++;
        emit && emit({ type: 'progress', done, total: unscraped.length, message: `PBP ${done}/${unscraped.length}` });
      }
    }

    await db.markTeamScraped(ncaa_team_id);
    await db.markSeasonScraped(ncaa_team_id, academic_year, SPORT, games.length);

    log('info', '=== Done ===');
    return { ok: true, games_saved: games.length };
  } catch (err) {
    log('error', `scrapeTeam failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

// Month name → number map
const MONTHS = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};

/**
 * Parse a date string to "YYYY-MM-DD".
 * academicYear (e.g. 2026) is used to infer the calendar year for year-less
 * date strings like "Feb 14" or "2/14".  NCAA baseball is a spring sport:
 *   months Jan–Jul  → use academicYear       (spring semester of that year)
 *   months Aug–Dec  → use academicYear - 1   (fall semester before)
 */
function parseDate(text, academicYear) {
  if (!text) return null;

  // ISO: "2025-03-01"
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // US with 4-digit year: "03/01/2025"
  const us4 = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us4) return `${us4[3]}-${us4[1].padStart(2,'0')}-${us4[2].padStart(2,'0')}`;

  // US with 2-digit year: "03/01/26"
  const us2 = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (us2) {
    const yr = 2000 + parseInt(us2[3], 10);
    return `${yr}-${us2[1].padStart(2,'0')}-${us2[2].padStart(2,'0')}`;
  }

  // Month name with year: "Mar 1, 2025" or "Mar 1 2025"
  const monYr = text.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (monYr) {
    const m = MONTHS[monYr[1].slice(0,3).toLowerCase()];
    if (m) return `${monYr[3]}-${String(m).padStart(2,'0')}-${monYr[2].padStart(2,'0')}`;
  }

  // Month name WITHOUT year: "Feb 14" or "Feb. 14"
  const monNoYr = text.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?$/);
  if (monNoYr && academicYear) {
    const m = MONTHS[monNoYr[1].slice(0,3).toLowerCase()];
    if (m) {
      const yr = m >= 8 ? academicYear - 1 : academicYear;
      return `${yr}-${String(m).padStart(2,'0')}-${monNoYr[2].padStart(2,'0')}`;
    }
  }

  // Month/day only, no year: "2/14" or "02/14"
  const mdNoYr = text.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (mdNoYr && academicYear) {
    const m = parseInt(mdNoYr[1], 10);
    const yr = m >= 8 ? academicYear - 1 : academicYear;
    return `${yr}-${String(m).padStart(2,'0')}-${mdNoYr[2].padStart(2,'0')}`;
  }

  return null;
}

function parseScore(text, isAway = false) {
  if (!text) return { ourScore: null, oppScore: null, result: null };
  // "W, 6-4" or "L, 2-10" or "W 6-4" or "6-4 W"
  const m = text.match(/([WLT])[,\s]+(\d+)-(\d+)/i) || text.match(/(\d+)-(\d+)\s+([WLT])/i);
  if (!m) return { ourScore: null, oppScore: null, result: null };

  let resultChar, score1, score2;
  if (m[3] && /[WLT]/i.test(m[3])) {
    // "6-4 W" format
    score1 = parseInt(m[1], 10);
    score2 = parseInt(m[2], 10);
    resultChar = m[3].toUpperCase();
  } else {
    resultChar = m[1].toUpperCase();
    score1 = parseInt(m[2], 10);
    score2 = parseInt(m[3], 10);
  }

  // score1 is "our team" score, score2 is opponent score (both W and L formats give winner first)
  // W means our team won → our score is higher
  // L means opponent won → opponent score is higher
  // The schedule page usually shows: W, 6-4 means OurTeam 6, Opp 4
  return { ourScore: score1, oppScore: score2, result: resultChar };
}

function cleanOppName(name) {
  return name
    .replace(/^(at|vs\.?)\s+/i, '')
    .replace(/\s*\([\d-]+\)\s*$/, '')  // remove win-loss records in parens
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Backfill: resolve batter IDs for already-scraped plays ─────────────────

async function resolvePlayBatterIds(ncaa_team_id, academic_year, emit = null) {
  emit && emit({ type: 'info', message: 'Querying plays that need batter resolution…' });
  const plays = await db.getPlaysNeedingResolution(ncaa_team_id, academic_year);
  emit && emit({ type: 'info', message: `Found ${plays.length} unresolved play rows` });
  if (plays.length === 0) return { resolved: 0, matched: 0, total: 0 };

  const teamIds = new Set([ncaa_team_id]);
  for (const p of plays) {
    if (p.opponent_team_id) teamIds.add(Number(p.opponent_team_id));
  }
  emit && emit({ type: 'info', message: `Loading rosters for ${teamIds.size} team(s)…` });

  const rosterIndexes = new Map();
  for (const tid of teamIds) {
    const players = await db.getPlayers(tid, academic_year);
    rosterIndexes.set(tid, buildRosterIndex(players));
    emit && emit({ type: 'info', message: `  Team ${tid}: ${players.length} players` });
  }
  const emptyIndex = buildRosterIndex([]);

  let extracted = 0, matched = 0;
  for (let i = 0; i < plays.length; i++) {
    const play = plays[i];
    const name = extractBatterName(play.raw_text);
    if (!name) continue;
    extracted++;

    let battingTeamId = null;
    if (play.half === 'top') {
      battingTeamId = play.is_away
        ? Number(play.ncaa_team_id)
        : (play.opponent_team_id ? Number(play.opponent_team_id) : null);
    } else {
      battingTeamId = play.is_away
        ? (play.opponent_team_id ? Number(play.opponent_team_id) : null)
        : Number(play.ncaa_team_id);
    }

    const idx   = battingTeamId ? (rosterIndexes.get(battingTeamId) || emptyIndex) : emptyIndex;
    const found = lookupInRoster(name, idx);
    if (found) matched++;
    await db.updatePlayBatter(play.id, name, found ? found.ncaa_player_id : null);

    if ((i + 1) % 50 === 0) {
      emit && emit({ type: 'progress', done: i + 1, total: plays.length, message: `Resolved ${i + 1}/${plays.length}` });
    }
  }

  emit && emit({ type: 'info', message: `Done — extracted ${extracted} names, matched ${matched} to roster IDs` });
  return { resolved: extracted, matched, total: plays.length };
}

// ─── Backfill: resolve pitcher names for already-scraped plays ───────────────

async function resolvePlayPitcherNames(ncaa_team_id, academic_year, emit = null) {
  emit && emit({ type: 'info', message: 'Loading all plays for pitcher resolution…' });

  // Fetch ALL plays for the team's games this season, ordered so we can track game flow
  const plays = await db.getAllPlaysForSeason(ncaa_team_id, academic_year);
  emit && emit({ type: 'info', message: `${plays.length} total plays across all games` });
  if (plays.length === 0) return { assigned: 0, total: 0 };

  // Group by game_id preserving order
  const byGame = new Map();
  for (const p of plays) {
    if (!byGame.has(p.game_id)) byGame.set(p.game_id, []);
    byGame.get(p.game_id).push(p);
  }

  let assigned = 0;
  let gamesDone = 0;
  const totalGames = byGame.size;

  for (const [, gamePlays] of byGame) {
    const pitcherMap = assignPitchersToGame(gamePlays);
    for (const [playId, name] of pitcherMap) {
      await db.updatePlayPitcher(playId, name);
      assigned++;
    }
    gamesDone++;
    if (gamesDone % 5 === 0 || gamesDone === totalGames) {
      emit && emit({ type: 'progress', done: gamesDone, total: totalGames,
        message: `Processed ${gamesDone}/${totalGames} games, ${assigned} pitchers assigned` });
    }
  }

  emit && emit({ type: 'info', message: `Done — assigned pitcher names to ${assigned} plays` });
  return { assigned, total: plays.length };
}

// ─── Season-to-date stats scraper ─────────────────────────────────────────

const PLAYER_ID_PATTERNS = [
  /\/players?\/(\d+)/,
  /stats_player_seq=(\d+)/,
  /[?&]id=(\d+)/,
  /player_id=(\d+)/,
];

function extractPlayerIdFromHref(href) {
  if (!href) return null;
  for (const pat of PLAYER_ID_PATTERNS) {
    const m = href.match(pat);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Parse a season stat table (batting or pitching) from the page.
 * Returns array of stat objects ready for upsert.
 *
 * type: 'batting' | 'pitching'
 */
function parseSeasonStatTable($, table, ncaa_team_id, academic_year, type) {
  const $table = $(table);
  const headers = $table.find('thead th, thead td')
    .map((_i, el) => $(el).text().trim().toLowerCase().replace(/[^a-z0-9]/g, ''))
    .get();

  if (!headers.length) return [];

  // Check this table has the right kind of data
  const isBatting  = headers.some(h => h === 'ab' || h === 'atbat' || h === 'atbats');
  const isPitching = headers.some(h => h === 'era' || h === 'ip' || h === 'inningspitched');
  if (type === 'batting'  && !isBatting)  return [];
  if (type === 'pitching' && !isPitching) return [];

  const idxOf = (...keys) => {
    for (const k of keys) { const i = headers.indexOf(k); if (i >= 0) return i; }
    return -1;
  };

  const playerIdx = idxOf('player', 'name', 'playername');
  const numIdx    = idxOf('no', 'num', 'number', '#');
  const posIdx    = idxOf('pos', 'position');
  const yrIdx     = idxOf('yr', 'year', 'cl', 'class');

  const rows = [];
  $table.find('tbody tr').each((_ri, row) => {
    const cells = $(row).find('td');
    if (cells.length < 3) return;

    // Find player name + ID from any link in the row
    let playerName = null;
    let ncaa_player_id = null;
    cells.each((_ci, cell) => {
      if (ncaa_player_id) return;
      const link = $(cell).find('a').first();
      if (!link.length) return;
      const href = link.attr('href') || '';
      const pid  = extractPlayerIdFromHref(href);
      if (pid) {
        ncaa_player_id = pid;
        playerName     = link.text().trim() || null;
      }
    });

    // Fallback: player column text
    if (!playerName && playerIdx >= 0) {
      playerName = cells.eq(playerIdx).text().trim() || null;
    }

    // Skip totals / header-like rows
    if (!ncaa_player_id) return;
    if (!playerName || /^total/i.test(playerName)) return;

    const cv = (idx) => {
      if (idx < 0 || idx >= cells.length) return null;
      const v = cells.eq(idx).text().trim().replace(/[^0-9.\-]/g, '');
      return v === '' ? null : Number(v);
    };

    const jerseyNumber = numIdx >= 0 ? (cells.eq(numIdx).text().trim() || null) : null;
    const position     = posIdx >= 0 ? (cells.eq(posIdx).text().trim() || null) : null;
    const classYear    = yrIdx  >= 0 ? (cells.eq(yrIdx).text().trim()  || null) : null;

    // Upsert player metadata alongside stats
    const playerData = { ncaa_team_id, ncaa_player_id, academic_year, name: playerName, jersey_number: jerseyNumber, position, class_year: classYear };

    let statData;
    if (type === 'batting') {
      statData = {
        ncaa_team_id, ncaa_player_id, academic_year,
        g:       cv(idxOf('g', 'gp', 'games')),
        ab:      cv(idxOf('ab', 'atbat', 'atbats')),
        r:       cv(idxOf('r', 'runs')),
        h:       cv(idxOf('h', 'hits')),
        doubles: cv(idxOf('2b')),
        triples: cv(idxOf('3b')),
        hr:      cv(idxOf('hr')),
        rbi:     cv(idxOf('rbi')),
        bb:      cv(idxOf('bb', 'walks', 'walk')),
        so:      cv(idxOf('so', 'k', 'strikeouts')),
        sb:      cv(idxOf('sb')),
        cs:      cv(idxOf('cs')),
        hbp:     cv(idxOf('hp', 'hbp')),
        sf:      cv(idxOf('sf')),
        sh:      cv(idxOf('sh', 'sac')),
        avg:     cv(idxOf('avg', 'ba', 'avera')),
        obp:     cv(idxOf('obp', 'obpct', 'onbase')),
        slg:     cv(idxOf('slg', 'slgpct')),
        ops:     cv(idxOf('ops', 'opspct')),
      };
    } else {
      statData = {
        ncaa_team_id, ncaa_player_id, academic_year,
        g:   cv(idxOf('g', 'gp', 'games')),
        gs:  cv(idxOf('gs')),
        w:   cv(idxOf('w', 'wins')),
        l:   cv(idxOf('l', 'losses')),
        sv:  cv(idxOf('sv', 'saves')),
        ip:  cv(idxOf('ip', 'inningspitched')),
        h:   cv(idxOf('h', 'hits')),
        r:   cv(idxOf('r', 'runs')),
        er:  cv(idxOf('er', 'earnedruns')),
        bb:  cv(idxOf('bb', 'walks', 'walk')),
        so:  cv(idxOf('so', 'k', 'strikeouts')),
        hr:  cv(idxOf('hr')),
        hbp: cv(idxOf('hp', 'hbp')),
        era: cv(idxOf('era')),
        whip:cv(idxOf('whip')),
      };
    }

    rows.push({ playerData, statData });
  });

  return rows;
}

/**
 * Scrape season-to-date batting and pitching stats for a team.
 * URL: https://stats.ncaa.org/teams/:ncaa_team_id/season_to_date_stats
 * Returns { batting: [...rows], pitching: [...rows] }
 */
async function scrapeSeasonToDateStats(ncaa_team_id, academic_year, emit = null) {
  const log = (type, msg) => { emit && emit({ type, message: msg }); console.log(`[${type}] ${msg}`); };

  const battingUrl = `${BASE}/teams/${ncaa_team_id}/season_to_date_stats`;
  log('info', `Fetching season-to-date stats: ${battingUrl}`);

  let html;
  try {
    html = await fetchHTML(battingUrl);
  } catch (e) {
    log('error', `Stats fetch failed: ${e.message}`);
    return { batting: [], pitching: [] };
  }

  const $ = cheerio.load(html);

  // Parse batting tables
  const battingRows = [];
  $('table').each((_ti, table) => {
    const parsed = parseSeasonStatTable($, table, ncaa_team_id, academic_year, 'batting');
    battingRows.push(...parsed);
  });
  log('info', `Batting: ${battingRows.length} player rows`);

  // Find pitching stats link — look for <a> whose text contains 'pitch'
  let pitchingUrl = null;
  $('a').each((_i, el) => {
    if (pitchingUrl) return;
    const txt  = $(el).text().trim().toLowerCase();
    const href = $(el).attr('href') || '';
    if (txt.includes('pitch') && href && !href.startsWith('javascript')) {
      pitchingUrl = href.startsWith('http') ? href : `${BASE}${href.startsWith('/') ? '' : '/'}${href}`;
    }
  });

  // Upsert batting players + stats
  for (const { playerData, statData } of battingRows) {
    try { await db.upsertPlayer(playerData); } catch(e) { /* non-fatal */ }
    try { await db.upsertBattingStats(statData); } catch(e) { log('warn', `Batting upsert error: ${e.message}`); }
  }

  // Scrape pitching
  const pitchingRows = [];
  if (pitchingUrl) {
    log('info', `Fetching pitching stats: ${pitchingUrl}`);
    await sleep(DELAY_MS);
    try {
      const pitchHtml = await fetchHTML(pitchingUrl);
      const $p = cheerio.load(pitchHtml);
      $p('table').each((_ti, table) => {
        const parsed = parseSeasonStatTable($p, table, ncaa_team_id, academic_year, 'pitching');
        pitchingRows.push(...parsed);
      });
      log('info', `Pitching: ${pitchingRows.length} player rows`);
    } catch (e) {
      log('warn', `Pitching stats fetch failed: ${e.message}`);
    }
  } else {
    log('warn', 'No pitching stats link found on page');
  }

  // Upsert pitching players + stats
  for (const { playerData, statData } of pitchingRows) {
    try { await db.upsertPlayer(playerData); } catch(e) { /* non-fatal */ }
    try { await db.upsertPitchingStats(statData); } catch(e) { log('warn', `Pitching upsert error: ${e.message}`); }
  }

  return { batting: battingRows.map(r => r.statData), pitching: pitchingRows.map(r => r.statData) };
}

// ─── Situational hitting scraper ───────────────────────────────────────────
// GET /contests/:contest_id/situational_stats
// Scrapes the situational hitting table for ncaa_team_id and saves per-game rows.

function parseHAB(cell) {
  // Parse "H-AB" string like "2-7" into { h: 2, ab: 7 }. Returns zeros for empty/missing.
  const s = (cell || '').trim();
  const m = s.match(/^(\d+)-(\d+)$/);
  if (!m) return { h: 0, ab: 0 };
  return { h: parseInt(m[1], 10), ab: parseInt(m[2], 10) };
}

// Convert "LastName, FirstName" → "FirstName LastName" for roster lookup
function lastFirstToFirstLast(name) {
  if (!name) return '';
  const comma = name.indexOf(',');
  if (comma === -1) return name.trim();
  const last  = name.slice(0, comma).trim();
  const first = name.slice(comma + 1).trim();
  return first ? `${first} ${last}` : last;
}

async function scrapeSituationalHitting(ncaa_team_id, academic_year, emit = null) {
  // Load the roster for name matching
  const players = await db.getPlayers(ncaa_team_id, academic_year);
  const rosterIdx = buildRosterIndex(players);

  // Load team name so we can identify the right half of the page
  const team = await db.getTeam(ncaa_team_id);
  const teamNameLower = (team?.name || '').toLowerCase();

  // Get all games with a contest_id for this team/year
  const games = await db.getGames(ncaa_team_id, academic_year);
  const scrapable = games.filter(g => g.contest_id);

  emit && emit({ type: 'info', message: `Situational hitting: ${scrapable.length} games to scrape` });

  let scraped = 0, skipped = 0;

  for (const game of scrapable) {
    const url = `${BASE}/contests/${game.contest_id}/situational_stats`;
    emit && emit({ type: 'info', message: `Fetching ${url}` });

    let html;
    try {
      html = await fetchHTML(url, { waitForSelector: 'table' });
    } catch (e) {
      emit && emit({ type: 'warn', message: `Could not fetch contest ${game.contest_id}: ${e.message}` });
      skipped++;
      continue;
    }

    const $ = cheerio.load(html);

    // The page has two side-by-side hitting panels. Find the one whose heading
    // contains our team name.
    let targetTable = null;
    $('table').each((_i, tbl) => {
      // Look for a nearby heading (h3, h4, or strong) that contains our team name
      const heading = $(tbl).closest('[class*="col"]').find('h3,h4,h5,strong').first().text().toLowerCase();
      if (heading.includes(teamNameLower) || (teamNameLower && heading.includes(teamNameLower.split(' ')[0]))) {
        targetTable = tbl;
        return false; // break
      }
    });

    // Fallback: use the first table if we couldn't identify by heading
    if (!targetTable) {
      targetTable = $('table').first().get(0);
    }

    if (!targetTable) {
      emit && emit({ type: 'warn', message: `No table found for contest ${game.contest_id}` });
      skipped++;
      continue;
    }

    const rows = $(targetTable).find('tbody tr');
    let saved = 0;

    rows.each((_i, tr) => {
      const cells = $(tr).find('td');
      if (cells.length < 10) return; // skip header-like rows

      const rawName = $(cells.get(0)).text().trim();
      if (!rawName) return;

      // Skip the totals row — first cell matches team name or is a colspan summary
      const nameLower = rawName.toLowerCase();
      if (
        nameLower === teamNameLower ||
        nameLower.includes('total') ||
        (teamNameLower && nameLower === teamNameLower.split(' ')[0].toLowerCase())
      ) return;

      const position = $(cells.get(1)).text().trim() || null;

      // Parse stat cells (indices 2–14)
      const c = (i) => $(cells.get(i)).text().trim();
      const wr   = parseHAB(c(2));
      const sp   = parseHAB(c(3));
      const lhp  = parseHAB(c(4));
      const rhp  = parseHAB(c(5));
      const lo   = parseHAB(c(6));
      const r3   = parseHAB(c(7));
      const ph   = parseHAB(c(8));
      const ao   = parseHAB(c(9));
      const two  = parseHAB(c(10));
      const wr2  = parseHAB(c(11));
      const sp2  = parseHAB(c(12));
      const be   = parseHAB(c(13));
      const bl   = parseHAB(c(14));

      // Match player name to roster
      const firstLast = lastFirstToFirstLast(rawName);
      const matched = lookupInRoster(firstLast, rosterIdx);

      db.upsertSituationalHitting({
        ncaa_team_id,
        contest_id: game.contest_id,
        academic_year,
        player_name: rawName,
        ncaa_player_id: matched?.ncaa_player_id || null,
        position,
        with_runners_h: wr.h,   with_runners_ab: wr.ab,
        scorepos_h: sp.h,       scorepos_ab: sp.ab,
        vs_lhp_h: lhp.h,        vs_lhp_ab: lhp.ab,
        vs_rhp_h: rhp.h,        vs_rhp_ab: rhp.ab,
        leadoff_h: lo.h,        leadoff_ab: lo.ab,
        rbi_3rd_h: r3.h,        rbi_3rd_ab: r3.ab,
        pinch_hit_h: ph.h,      pinch_hit_ab: ph.ab,
        adv_outs_h: ao.h,       adv_outs_ab: ao.ab,
        two_outs_h: two.h,      two_outs_ab: two.ab,
        runners2_h: wr2.h,      runners2_ab: wr2.ab,
        scorepos2_h: sp2.h,     scorepos2_ab: sp2.ab,
        bases_empty_h: be.h,    bases_empty_ab: be.ab,
        bases_loaded_h: bl.h,   bases_loaded_ab: bl.ab,
      }).catch(e => emit && emit({ type: 'warn', message: `upsert failed for ${rawName}: ${e.message}` }));

      saved++;
    });

    emit && emit({ type: 'info', message: `Contest ${game.contest_id}: saved ${saved} player rows` });
    scraped++;
    await sleep(DELAY_MS);
  }

  emit && emit({ type: 'done', message: `Situational hitting done — ${scraped} games scraped, ${skipped} skipped` });
}

module.exports = {
  fetchHTML,
  fetchSeasonList,
  getSeasonId,
  searchNcaaTeams,
  lookupTeamByUrl,
  fetchAllTeamsRaw,
  fetchAllTeams,
  scrapeTeamSchedule,
  scrapePbp,
  scrapeRoster,
  scrapePlayerBattingStats,
  scrapeTeam,
  scrapeSeasonToDateStats,
  resolvePlayBatterIds,
  resolvePlayPitcherNames,
  scrapeSituationalHitting,
};