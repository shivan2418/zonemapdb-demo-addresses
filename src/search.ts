import { connect, type Db } from "./blockdb/client";
import type { Addresses } from "./blockdb/schema";
import rules from "../scripts/normalize.json";

type Where = NonNullable<NonNullable<Parameters<Db["addresses"]["findMany"]>[0]>["where"]>;

let db = connect({ basePath: `${import.meta.env.BASE_URL}blockdb` });

// The data lives next to the page. A relative basePath would resolve against whatever loads this
// module, and in the search worker that's the script's own URL (assets/), so the worker passes
// an absolute one.
export function useBasePath(basePath: string): void {
  db = connect({ basePath });
}

// Shared with scripts/compact.py: stored streets are already normalized with these lists, so
// typed text has to be normalized the same way before it can prefix-match. "FIFTH", "05TH" and
// "5 AVE" are all stored as "5TH".
const ABBREVIATIONS: Record<string, string> = rules.abbreviations;
const { unitOrdinals: UNIT_ORDINALS, teens: TEENS, tens: TENS, bareOrdinalTypes: BARE_ORDINAL_TYPES } = rules;

function ordinal(n: number): string {
  const suffix = [11, 12, 13].includes(n % 100) ? "TH" : ({ 1: "ST", 2: "ND", 3: "RD" }[n % 10] ?? "TH");
  return `${n}${suffix}`;
}

const ORDINAL_WORDS: Record<string, string> = Object.fromEntries([
  ...UNIT_ORDINALS.map((w, i) => [w, ordinal(i + 1)]),
  ...TEENS.map((w, i) => [w, ordinal(i + 10)]),
  ...TENS.map((t, i) => [t.slice(0, -1) + "IETH", ordinal(20 + 10 * i)]),
]);
const WORDS: Record<string, string> = { ...ABBREVIATIONS, ...ORDINAL_WORDS };

const STATE_NAMES: Record<string, string> = {
  ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA", COLORADO: "CO",
  CONNECTICUT: "CT", "DISTRICT OF COLUMBIA": "DC", DELAWARE: "DE", FLORIDA: "FL", GEORGIA: "GA",
  HAWAII: "HI", IDAHO: "ID", ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA", KANSAS: "KS",
  KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD", MASSACHUSETTS: "MA",
  MICHIGAN: "MI", MINNESOTA: "MN", MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT",
  NEBRASKA: "NE", NEVADA: "NV", "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM",
  "NEW YORK": "NY", "NORTH CAROLINA": "NC", "NORTH DAKOTA": "ND", OHIO: "OH", OKLAHOMA: "OK",
  OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI", "SOUTH CAROLINA": "SC",
  "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT", VIRGINIA: "VA",
  WASHINGTON: "WA", "WEST VIRGINIA": "WV", WISCONSIN: "WI", WYOMING: "WY",
};
const STATES = new Set(Object.values(STATE_NAMES));

// The same cleanup compact.py applies: uppercase, drop . , # |, collapse whitespace.
function clean(s: string): string {
  return s.toUpperCase().replace(/[.,#|]/g, "").replace(/\s+/g, " ").trim();
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

// Could a half-typed token still become one of the street types a bare ordinal needs?
function mayBeType(t: string): boolean {
  return Object.entries(ABBREVIATIONS).some(([long, short]) => BARE_ORDINAL_TYPES.includes(short) && long.startsWith(t))
    || BARE_ORDINAL_TYPES.some((type) => type.startsWith(t));
}

// The typed street, normalized the way compact.py normalizes stored streets, as a prefix to
// match against them. The last token may still be half-typed, so it is only ever loosened:
// "MAIN STRE" is on its way to STREET, stored as ST, so it is cut back to what it shares with
// the abbreviation ("ST"); a half-typed ordinal word ("FIFT": FIFTH? FIFTEENTH?) is dropped.
// A looser prefix only means more candidates, never missing ones. Returns null while there is
// nothing left to match on.
function streetPrefix(text: string, typing = true): string | null {
  const tens = TENS.join("|");
  const units = UNIT_ORDINALS.join("|");
  const joined = clean(text).replace(new RegExp(`\\b(${tens})-(${units})\\b`, "g"), "$1 $2");
  let tokens = joined.split(" ").filter(Boolean);
  const typedLast = tokens.at(-1);
  const lastIsWord = typedLast !== undefined && typedLast in WORDS;
  tokens = tokens.map((t) => WORDS[t] ?? t);

  // "TWENTY 1ST" → "21ST"
  for (let i = 0; i < tokens.length - 1; i++) {
    const tensIndex = TENS.indexOf(tokens[i]);
    if (tensIndex >= 0 && /^[1-9](ST|ND|RD|TH)$/.test(tokens[i + 1])) {
      tokens.splice(i, 2, `${tensIndex + 2}${tokens[i + 1]}`);
    }
  }

  const last = tokens.length - 1;
  if (typing && last >= 0 && !lastIsWord) {
    const t = tokens[last];
    const partial = Object.entries(ABBREVIATIONS).find(([long, short]) => long.startsWith(t) && !short.startsWith(t));
    if (partial) tokens[last] = commonPrefix(t, partial[1]) || t;
    else if (t.length >= 2 && Object.keys(ORDINAL_WORDS).some((w) => w.startsWith(t))) tokens.pop();
  }

  tokens = tokens.map((t, i) => {
    const m = t.match(/^0*([1-9]\d*)(ST|ND|RD|TH)?$/);
    if (!m) return t;
    const n = Number(m[1]);
    if (m[2]) return ordinal(n);
    const next = tokens[i + 1];
    if (next === undefined) return m[1];
    const nextIsTyped = typing && i + 1 === tokens.length - 1 && !lastIsWord;
    return BARE_ORDINAL_TYPES.includes(next) || (nextIsTyped && mayBeType(next)) ? ordinal(n) : t;
  });

  return tokens.length ? tokens.join(" ") : null;
}

export interface Query {
  number?: string;
  street?: string;
  /** The street is complete: a comma, or a city, state or ZIP came after it. */
  streetEnded?: true;
  city?: string;
  state?: string;
  postcode?: string;
}

const STREET_TYPES = new Set(rules.streetTypes);
const DIRECTIONS = new Set(["N", "S", "E", "W", "NE", "NW", "SE", "SW"]);

type Place = Pick<Query, "city" | "state" | "postcode">;

// A state at one end of the tokens, as a code ("NY") or a name ("NEW YORK").
function takeState(t: string[], fromEnd: boolean): { state: string; byName: boolean } | null {
  for (const n of [3, 2, 1]) {
    if (t.length < n) continue;
    const words = fromEnd ? t.slice(-n) : t.slice(0, n);
    const text = words.join(" ");
    const state = STATE_NAMES[text] ?? (n === 1 && STATES.has(text) ? text : undefined);
    if (!state) continue;
    t.splice(fromEnd ? t.length - n : 0, n);
    return { state, byName: !STATES.has(text) };
  }
  return null;
}

// City, state and ZIP from the tokens around the street, in any order: "EASTCHESTER NY 10709",
// "10709", "NEW YORK". When `typing` is set these tokens end the input and the last one may be
// half-typed: a partial ZIP is matched as a prefix and a partial state code is dropped.
// A state name with nothing else around it ("WASHINGTON") may just as well be a city, so it
// yields both readings.
function places(tokens: string[], typing: boolean): Place[] {
  const t = [...tokens];
  const q: Place = {};
  const zip = t.findIndex((x) => /^\d{5}(-\d{4})?$/.test(x));
  if (zip >= 0) q.postcode = t.splice(zip, 1)[0].slice(0, 5);
  else if (typing && t.length && /^\d{1,4}$/.test(t.at(-1)!)) q.postcode = t.pop();

  const state = takeState(t, true) ?? takeState(t, false);
  if (state) q.state = state.state;
  else if (typing && !q.postcode && t.length > 1 && t.at(-1)!.length <= 2
    && [...STATES].some((s) => s.startsWith(t.at(-1)!))) t.pop();
  if (t.length) q.city = t.join(" ");

  if (state?.byName && !t.length) {
    const asCity = { ...q, city: Object.keys(STATE_NAMES).find((k) => STATE_NAMES[k] === q.state) };
    delete asCity.state;
    return [q, asCity];
  }
  return [q];
}

function isHouseNumber(t: string): boolean {
  // An ordinal ("5TH AVE") starts the street, not a house number.
  return /^\d[\w-]*$/.test(t) && !/^\d+(ST|ND|RD|TH)$/.test(t);
}

function query(number: string | undefined, streetTokens: string[], place: Place, ended = false): Query | null {
  // A finished street isn't half-typed, so its last word is taken as it is.
  const street = streetTokens.length ? streetPrefix(streetTokens.join(" "), !ended) : null;
  if (!street) return null;
  return { ...(number && { number }), street, ...(ended && { streetEnded: true as const }), ...place };
}

// Every plausible reading of the input, most specific first. Nothing about the order is
// required: "2 ridge st eastchester ny 10709", "2 Ridge St, Eastchester, NY 10709",
// "eastchester 2 ridge st" and "10709 2 ridge st" all read the same way.
//
// The house number is the first number that isn't a ZIP. Whatever comes before it is place. After it comes the street, then maybe more place: the street ends
// at a comma if there is one, and otherwise at a street type ("ST", "AVE", ...) or a direction
// right after one. A street type can also be part of the name ("ST JAMES PL", "MAIN ST EXT")
// and "NE" can be a direction or Nebraska, so each possible end yields its own reading, and the
// whole rest is always tried as the street too.
export function parse(input: string): Query[] {
  const tokens: string[] = [];
  const commaAfter = new Set<number>();
  for (const segment of input.split(",")) {
    tokens.push(...clean(segment).split(" ").filter(Boolean));
    if (tokens.length) commaAfter.add(tokens.length);
  }
  commaAfter.delete(tokens.length);

  // A five-digit number is a ZIP unless a word follows it ("10709 2 ridge st", "ridge st 10709").
  const isZip = (i: number) => /^\d{5}$/.test(tokens[i]) && (i + 1 >= tokens.length || isHouseNumber(tokens[i + 1]));
  const h = tokens.findIndex((t, i) => isHouseNumber(t) && !isZip(i));
  // Just a number so far, or a house number with no street after it yet.
  if (h === tokens.length - 1 || (tokens.length === 1 && /^\d/.test(tokens[0]))) return [];
  const number = h >= 0 ? tokens[h] : undefined;
  const lead = h >= 0 ? tokens.slice(0, h) : [];
  const start = h >= 0 ? h + 1 : 0;
  const body = tokens.slice(start);
  const leadPlaces = lead.length ? places(lead, false) : [{}];

  const ends = new Set<number>();
  const comma = [...commaAfter].find((c) => c > start);
  if (comma !== undefined) ends.add(comma - start);
  else {
    body.forEach((t, i) => {
      if (i === 0 || !STREET_TYPES.has(WORDS[t] ?? t)) return;
      ends.add(i + 1);
      const next = body[i + 1];
      if (next && DIRECTIONS.has(WORDS[next] ?? next)) ends.add(i + 2);
    });
    // A trailing ZIP with no street type to split on: "2 ridge 10709".
    if (!ends.size && body.length > 1 && /^\d{5}$/.test(body.at(-1)!)) ends.add(body.length - 1);
  }

  const readings: Query[] = [];
  for (const end of [...ends].sort((x, y) => y - x)) {
    if (end >= body.length) continue;
    for (const lp of leadPlaces) {
      for (const tp of places(body.slice(end), true)) {
        const q = query(number, body.slice(0, end), { ...lp, ...tp }, true);
        if (q) readings.push(q);
      }
    }
  }
  if (comma === undefined) {
    for (const lp of leadPlaces) {
      const q = query(number, body, lp);
      if (q) readings.push(q);
    }
  }
  return readings;
}

// Records are sorted by key, "STREET|CITY|STATE" (see compact.py). A street still being typed
// is a prefix of the key; a finished one narrows it to that street, and with a city to that
// town's run of blocks, which is the whole point of the key: "MAIN ST|SPRINGFIELD" reads one
// block, where "MAIN ST" alone spans every town in the country.
export function keyPrefix(q: Query): string {
  return q.streetEnded ? `${q.street}|${q.city ?? ""}` : q.street!;
}

function where(q: Query): Where {
  const key = keyPrefix(q);
  const cityInKey = q.streetEnded && q.city;
  return {
    key: { startsWith: key },
    ...(q.number && { number: { equals: q.number } }),
    ...(q.city && !cityInKey && { city: { startsWith: q.city } }),
    ...(q.state && { state: { equals: q.state } }),
    ...(q.postcode && { postcode: q.postcode.length === 5 ? { equals: q.postcode } : { startsWith: q.postcode } }),
  };
}

const MIN_STREET = 3;

// Resolves to null when the input can't be searched yet: a bare number would match millions of
// records, so wait for at least the first few letters of the street. Every reading of the input is queried
// at once and the results are merged.
// Search-as-you-type starts a query per pause, and each downloads at least one data block.
// A search whose input the new one merely extends ("123 MAI" → "123 MAIN") is left to finish:
// it's fetching mostly the same blocks, which the browser then has cached. Anything else
// (a deletion, a different word) cancels it; its promise rejects with code ABORTED.
let previous: { input: string; controller: AbortController } | null = null;

export async function search(input: string, limit = 20): Promise<Addresses[] | null> {
  if (previous && !input.startsWith(previous.input)) previous.controller.abort();
  const controller = new AbortController();
  previous = { input, controller };
  const { signal } = controller;
  // One or two letters of a street match nearly everything, so they'd only cost a download.
  const parsed = parse(input).filter((q) => q.street!.replace(/ /g, "").length >= MIN_STREET);
  if (!parsed.length) return null;
  // Each reading is searched as an exact street first: its key prefix names one run of blocks
  // ("MAIN ST|SPRINGFIELD"). Only if that finds fewer than a full page does it fall back to the
  // street as a prefix, which also matches what was left off ("PENNSYLVANIA AVE" → "... NW")
  // and variants ("MAIN ST EXT"), with the city as a separate filter. The exact results come
  // first either way, since variants sort ahead of the plain street (a space sorts before "|").
  const lists = await Promise.all(
    parsed.map(async (q) => {
      const exact = await db.addresses.findMany({ where: where({ ...q, streetEnded: true }), limit, signal });
      if (exact.records.length >= limit) return exact.records;
      const { streetEnded: _, ...open } = q;
      const more = await db.addresses.findMany({ where: where(open), limit, signal });
      return [...exact.records, ...more.records];
    }),
  );
  // Interleave the readings, so one that matches nothing useful can't crowd out the others.
  const unique = new Map<string, Addresses>();
  for (let i = 0; unique.size < limit && lists.some((l) => i < l.length); i++) {
    for (const list of lists) {
      const r = list[i];
      if (r && !unique.has(format(r))) unique.set(format(r), r);
    }
  }
  return [...unique.values()].slice(0, limit);
}

// Answered from the manifest alone: an empty filter is the one count zonemapdb knows exactly.
export async function totalAddresses(): Promise<number> {
  return (await db.addresses.count()).count;
}

const KEEP_UPPER = new Set(["N", "S", "E", "W", "NE", "NW", "SE", "SW"]);

function titleCase(s: string): string {
  return s
    .split(" ")
    .map((w) => (KEEP_UPPER.has(w) ? w : /\d/.test(w) ? w.toLowerCase() : w[0] + w.slice(1).toLowerCase()))
    .join(" ");
}

export function format(a: Addresses): string {
  const line1 = [a.number, titleCase(a.street), a.unit && `#${a.unit}`].filter(Boolean).join(" ");
  const line2 = [a.state, a.postcode].filter(Boolean).join(" ");
  return [line1, a.city && titleCase(a.city), line2].filter(Boolean).join(", ");
}
