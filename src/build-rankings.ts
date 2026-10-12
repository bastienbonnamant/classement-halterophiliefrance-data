/**
 * Builds the static JSON files read by the rankings widget on halterophiliefrance.fr.
 * Scrapes scoresheet.ffhaltero.fr and writes data/<seasonId>.json + data/index.json.
 *
 * Usage:
 *   npm run build                # current season only (weekly job)
 *   npm run build -- --season=8  # one given season
 *   npm run build -- --all       # every season (3 .. current)
 *   npm run build -- --limit=15  # only the first N competitions (smoke test)
 *   npm run build -- --index-only # rebuild index.json from the existing files
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
function clubHomeRegions(
  rows: { club: string | null; league: string | null; team: boolean }[],
  prior: Map<string, string> = new Map(),
) {
  // Trois niveaux, du plus fiable au moins fiable :
  //  1. la région déjà connue du club dans les saisons précédentes (une saison entière de résultats) ;
  //  2. sinon, les compétitions individuelles régionales de la saison (hors par équipes et "FRANCE") ;
  //  3. à défaut, n'importe quelle compétition de la saison.
  // En début de saison, un club n'a couru que quelques compétitions, souvent organisées dans une autre
  // ligue (Top 9, plateaux ouverts) : ces votes donneraient une fausse région.
  const regional = new Map<string, Map<string, number>>();
  const any = new Map<string, Map<string, number>>();
  const add = (m: Map<string, Map<string, number>>, key: string, league: string) => {
    const byLeague = m.get(key) ?? new Map<string, number>();
    byLeague.set(league, (byLeague.get(league) ?? 0) + 1);
    m.set(key, byLeague);
  };
  for (const { club, league, team } of rows) {
    if (!club || !league) continue;
    const key = club.trim().toUpperCase();
    add(any, key, league);
    if (!team && league !== "FRANCE") add(regional, key, league);
  }
  const top = (byLeague: Map<string, number>, skipFrance: boolean) => {
    const ranked = [...byLeague.entries()].sort((a, b) => b[1] - a[1]);
    return (skipFrance ? ranked.find(([league]) => league !== "FRANCE") : undefined)?.[0] ?? ranked[0][0];
  };
  const home = new Map<string, string>();
  for (const [key, byLeague] of any) {
    const reg = regional.get(key);
    home.set(key, prior.get(key) ?? (reg ? top(reg, true) : top(byLeague, true)));
  }
  return home;
}

/** Région d'attache de chaque club d'après les saisons déjà construites (la plus récente d'abord). */
async function priorHomeRegions(seasonId: number) {
  const home = new Map<string, string>();
  for (let id = seasonId - 1; id >= 1; id--) {
    let data: { rows: Row[] };
    try {
      data = JSON.parse(await readFile(path.join(OUT_DIR, `${id}.json`), "utf8"));
    } catch {
      continue;
    }
    const counts = new Map<string, Map<string, number>>();
    for (const r of data.rows) {
      if (!r.c || !r.r || r.r === "FRANCE") continue;
      const key = r.c.trim().toUpperCase();
      if (home.has(key)) continue; // une saison plus récente a déjà tranché
      const byRegion = counts.get(key) ?? new Map<string, number>();
      byRegion.set(r.r, (byRegion.get(r.r) ?? 0) + 1);
      counts.set(key, byRegion);
    }
    for (const [key, byRegion] of counts) {
      home.set(key, [...byRegion.entries()].sort((a, b) => b[1] - a[1])[0][0]);
    }
  }
  return home;
}

async function buildSeason(seasonId: number, limit?: number) {
  // Compétitions individuelles ET par équipes (Top 9, N1…) : les pages d'équipes listent aussi la
  // performance de chaque athlète (arraché, épaulé-jeté, total, points IWF), souvent sa meilleure de la saison.
  const refs = parseSeasonList(await politeFetch(SEASON_URL(seasonId)));
  const targets = limit ? refs.slice(0, limit) : refs;
  console.log(`Saison ${seasonId}: ${targets.length}/${refs.length} compétitions (${refs.filter((c) => !c.individual).length} par équipes)`);

  const { results: details, errors } = await politeBatch(targets, async (c) =>
    parseCompetitionResults(await politeFetch(c.url), c.sourceId),
  );
  if (errors.length) console.warn(`${errors.length} compétition(s) en échec (ignorées)`);

  const teamIds = new Set(refs.filter((c) => !c.individual).map((c) => c.sourceId));
  const home = clubHomeRegions(
    details.flatMap((d) =>
      d.results.map((r) => ({ club: r.club, league: d.league, team: teamIds.has(d.sourceId) })),
    ),
    await priorHomeRegions(seasonId),
  );
  // Corrections manuelles éventuelles : club-regions.json, ex. { "EEAR MONTEUX": "PROVENCE-ALPES-COTE D'AZUR" }
  try {
    const manual = JSON.parse(await readFile(path.join(process.cwd(), "club-regions.json"), "utf8")) as Record<string, string>;
    for (const [club, region] of Object.entries(manual)) home.set(club.trim().toUpperCase(), region);
  } catch {
    /* pas de fichier de corrections : on garde les régions calculées */
  }

  const rows: Row[] = [];
  for (const d of details) {
    for (const r of d.results) {
      // Total absent ou nul : athlète inscrit à une compétition pas encore disputée, ou sans barre valide.
      if (r.total === null || r.total <= 0) continue;
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

/** Une saison entame le classement par défaut quand elle compte au moins ce nombre d'athlètes. */
const MIN_ATHLETES_FOR_DEFAULT = 1000;

/**
 * index.json liste les saisons ; la première est celle sur laquelle s'ouvre le widget.
 * C'est la plus récente qui compte assez d'athlètes : en début de saison, quelques
 * compétitions ne suffisent pas à faire un "top 100", on garde donc la saison précédente
 * en tête jusqu'à ce que la nouvelle soit bien remplie.
 */
async function writeIndex() {
  const files = (await readdir(OUT_DIR)).filter((f) => /^\d+\.json$/.test(f));
  const seasons: { id: number; label: string; updatedAt: string; athletes: number; default?: boolean }[] = [];
  for (const f of files) {
    const id = Number(f.replace(".json", ""));
    const data = JSON.parse(await readFile(path.join(OUT_DIR, f), "utf8"));
    const athletes = new Set((data.rows as Row[]).map((r) => r.l)).size;
    seasons.push({ id, label: seasonLabelForSourceId(id), updatedAt: data.updatedAt, athletes });
  }
  seasons.sort((a, b) => b.id - a.id);
  const preferred = seasons.find((s) => s.athletes >= MIN_ATHLETES_FOR_DEFAULT) ?? seasons[0];
  if (preferred) preferred.default = true;
  const ordered = preferred ? [preferred, ...seasons.filter((s) => s !== preferred)] : seasons;
  await writeFile(path.join(OUT_DIR, "index.json"), JSON.stringify({ seasons: ordered }) + "\n");
}

async function main() {
  const current = currentSourceSeasonId();
  const seasonArg = arg("season");
  const seasonIds = process.argv.includes("--all")
    ? Array.from({ length: current - 2 }, (_, i) => 3 + i)
    : [seasonArg ? Number(seasonArg) : current];
  const limit = arg("limit") ? Number(arg("limit")) : undefined;

  await mkdir(OUT_DIR, { recursive: true });
  if (process.argv.includes("--index-only")) {
    await writeIndex();
    return;
  }
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
