import * as cheerio from "cheerio";

export interface CompetitionRef {
  sourceId: number;
  url: string;
  individual: boolean;
}

export interface AthleteResult {
  licenceNumber: string;
  name: string;
  birthYear: number | null;
  club: string | null;
  nat: string | null;
  snatchBest: number | null;
  cjBest: number | null;
  total: number | null;
  categorie: string | null; // e.g. "SEN F 63", "M65 M 79"
  iwfPoints: number | null;
}

export interface CompetitionResults {
  sourceId: number;
  name: string;
  league: string | null; // organizing league, NOT the athletes' home region
  eventDate: string | null; // ISO yyyy-mm-dd
  results: AthleteResult[];
}

const BASE_URL = "https://scoresheet.ffhaltero.fr";

const clean = (value: string | undefined | null) =>
  (value ?? "").replace(/ /g, " ").trim();

function toNumber(value: string | undefined | null): number | null {
  const cleaned = clean(value).replace(",", ".");
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

const toInt = (value: string | undefined | null) => {
  const num = toNumber(value);
  return num === null ? null : Math.round(num);
};

/** Season list page (GET /scoresheet/{seasonId}) -> competitions of that season. */
export function parseSeasonList(html: string): CompetitionRef[] {
  const $ = cheerio.load(html);
  const refs: CompetitionRef[] = [];

  $("table#competitionSet > tbody > tr").each((_, row) => {
    const href = $(row).find("> td").first().find("a").first().attr("href");
    const id = href && /\/competition\/view\/(\d+)/.exec(href);
    if (!href || !id) return;
    refs.push({
      sourceId: Number(id[1]),
      url: `${BASE_URL}${href}`,
      individual: !href.includes("/team/competition/view/"),
    });
  });

  return refs;
}

const MONTHS: Record<string, number> = {
  jan: 1, fev: 2, feb: 2, mar: 3, avr: 4, apr: 4, mai: 5, may: 5, jun: 6,
  jul: 7, juil: 7, aou: 8, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function parseFrenchDate(text: string): string | null {
  // e.g. "23 Sep 2019", "ven 10 Jul 2026"
  const match = /(\d{1,2})\s+([A-Za-zéèêûô]+)\.?\s+(\d{4})/.exec(text);
  if (!match) return null;
  const [, day, monthRaw, year] = match;
  const key = monthRaw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .slice(0, 3);
  const month = MONTHS[key];
  return month ? `${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}` : null;
}

/** Competition page (GET /scoresheet/competition/view/{id}) -> header info + athlete results. */
export function parseCompetitionResults(html: string, sourceId: number): CompetitionResults {
  const $ = cheerio.load(html);

  const headerItem = $(".event-header__item").first();
  const name = clean(headerItem.find("h5").first().text());

  const header = headerItem.clone();
  header.find("h5, a#printButton, table").remove();
  const lines = header
    .text()
    .split("\n")
    .map(clean)
    .filter((line) => line.length > 0);

  let league: string | null = null;
  let eventDate: string | null = null;
  for (const line of lines) {
    const ligue = /^Ligue\s*:\s*(.+)$/.exec(line);
    if (ligue) league = ligue[1];
    else if (!eventDate) eventDate = parseFrenchDate(line);
  }

  // Some events (exhibitions) prepend an extra "TS" (draw order) column.
  const firstHeader = clean($("table.event-datatable thead tr").first().find("> th").first().text());
  const offset = firstHeader.toUpperCase() === "TS" ? 1 : 0;

  const results: AthleteResult[] = [];
  $("table.event-datatable > tbody > tr").each((_, row) => {
    const cells = $(row).find("> td");
    if (cells.length < 18 + offset) return;
    const col = (i: number) => cells.eq(i + offset);

    const licenceNumber = clean(col(0).text());
    if (!licenceNumber) return;

    const nameCell = col(1);
    const clubCell = col(3).clone();
    clubCell.find("font").remove();

    results.push({
      licenceNumber,
      name: clean(nameCell.find("a").first().text()) || clean(nameCell.text()),
      birthYear: toInt(col(2).text()),
      club: clean(clubCell.text()) || null,
      nat: clean(col(4).text()) || null,
      snatchBest: toInt(col(9).text()),
      cjBest: toInt(col(13).text()),
      total: toInt(col(14).text()),
      categorie: clean(col(16).text()) || null,
      iwfPoints: toNumber(col(17).text()),
    });
  });

  return { sourceId, name, league, eventDate, results };
}
