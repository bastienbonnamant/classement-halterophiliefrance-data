/**
 * Builds the static JSON files read by the rankings widget on halterophiliefrance.fr.
 * Scrapes scoresheet.ffhaltero.fr and writes data/<seasonId>.json + data/index.json.
 *
 * Usage:
 *   npm run build                # current season only (weekly job)
 *   npm run build -- --season=8  # one given season
 *   npm run build -- --all       # every season (3 .. current)
 *   npm run build -- --limit=15  # only the first N competitions (smoke test)
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { politeBatch, politeFetch } from "./http";
import { parseCompetitionResults, parseSeasonList } from "./parse";
import { currentSourceSeasonId, seasonLabelForSourceId } from "./season";

const OUT_DIR = path.join(process.cwd(), "data");
const SEASON_URL = (id: number) => `https://scoresheet.ffhaltero.fr/scoresheet/${id}`;

/** One athlete's result in one competition (short keys: every visitor downloads the file). */
interface Row {
  n: string; // name
  l: string; // licence number
  y: number | null; // birth year
  c: string | null; // club
  r: string | null; // region (home league of the club)
  p: string | null; // nationality
  k: string | null; // categorie, e.g. "SEN F 63"
  s: number | null; // snatch best
  j: number | null; // clean & jerk best
  t: number; // total
  i: number | null; // IWF points
  d: string | null; // event date
  e: string; // competition name
  q: number; // competition id on scoresheet
}

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

/**
 * A club has no official region in the source: the "Ligue" of a competition is
 * the *organizing* league. A club's home region is the league under which its
 * athletes appear most often. National events ("FRANCE") are hosted everywhere,
 * so they only count when a club has no regional result at all.
 */
function clubHomeRegions(rows: { club: string | null; league: string | null }[]) {
  const counts = new Map<string, Map<string, number>>();
  for (const { club, league } of rows) {
    if (!club || !league) continue;
    const key = club.trim().toUpperCase();
    const byLeague = counts.get(key) ?? new Map<string, number>();
    byLeague.set(league, (byLeague.get(league) ?? 0) + 1);
    counts.set(key, byLeague);
  }
  const home = new Map<string, string>();
  for (const [key, byLeague] of counts) {
    const ranked = [...byLeague.entries()].sort((a, b) => b[1] - a[1]);
    home.set(key, (ranked.find(([league]) => league !== "FRANCE") ?? ranked[0])[0]);
  }
  return home;
}

async function buildSeason(seasonId: number, limit?: number) {
  const refs = parseSeasonList(await politeFetch(SEASON_URL(seasonId))).filter((c) => c.individual);
  const targets = limit ? refs.slice(0, limit) : refs;
  console.log(`Saison ${seasonId}: ${targets.length}/${refs.length} compétitions individuelles`);

  const { results: details, errors } = await politeBatch(targets, async (c) =>
    parseCompetitionResults(await politeFetch(c.url), c.sourceId),
  );
  if (errors.length) console.warn(`${errors.length} compétition(s) en échec (ignorées)`);

  const home = clubHomeRegions(
    details.flatMap((d) => d.results.map((r) => ({ club: r.club, league: d.league }))),
  );

  const rows: Row[] = [];
  for (const d of details) {
    for (const r of d.results) {
      if (r.total === null) continue;
      rows.push({
        n: r.name,
        l: r.licenceNumber,
        y: r.birthYear,
        c: r.club,
        r: (r.club && home.get(r.club.trim().toUpperCase())) || d.league,
        p: r.nat,
        k: r.categorie,
        s: r.snatchBest,
        j: r.cjBest,
        t: r.total,
        i: r.iwfPoints,
        d: d.eventDate,
        e: d.name,
        q: d.sourceId,
      });
    }
  }

  // Deterministic order keeps weekly commits small when little has changed.
  rows.sort((a, b) => a.q - b.q || a.l.localeCompare(b.l));
  console.log(`Saison ${seasonId}: ${rows.length} résultats`);
  return rows;
}

async function writeIndex() {
  const files = (await readdir(OUT_DIR)).filter((f) => /^\d+\.json$/.test(f));
  const seasons = [];
  for (const f of files) {
    const id = Number(f.replace(".json", ""));
    const data = JSON.parse(await readFile(path.join(OUT_DIR, f), "utf8"));
    seasons.push({ id, label: seasonLabelForSourceId(id), updatedAt: data.updatedAt });
  }
  seasons.sort((a, b) => b.id - a.id);
  await writeFile(path.join(OUT_DIR, "index.json"), JSON.stringify({ seasons }) + "\n");
}

async function main() {
  const current = currentSourceSeasonId();
  const seasonArg = arg("season");
  const seasonIds = process.argv.includes("--all")
    ? Array.from({ length: current - 2 }, (_, i) => 3 + i)
    : [seasonArg ? Number(seasonArg) : current];
  const limit = arg("limit") ? Number(arg("limit")) : undefined;

  await mkdir(OUT_DIR, { recursive: true });
  for (const id of seasonIds) {
    const rows = await buildSeason(id, limit);
    if (rows.length === 0) {
      console.warn(`Saison ${id}: aucun résultat, fichier non écrasé`);
      continue;
    }
    await writeFile(
      path.join(OUT_DIR, `${id}.json`),
      JSON.stringify({
        season: id,
        label: seasonLabelForSourceId(id),
        updatedAt: new Date().toISOString(),
        rows,
      }) + "\n",
    );
  }
  await writeIndex();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
