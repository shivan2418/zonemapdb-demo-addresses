"""Merge, clean and deduplicate US addresses into per-state NDJSON for zonemapdb.

Sources, both read per state:
  - addresses/us/<state>/*-addresses-*.geojson, extracted from the OpenAddresses collection zips
  - overture/us.parquet, the US rows of Overture's addresses theme (mostly the National
    Address Database), fetched by scripts/fetch_overture.py

Missing ZIP codes and cities are then filled in from Census boundaries (census/*.zip) by
point-in-polygon lookup. Writes data/addresses/<state>.ndjson: one flat record per unique
address, coordinates dropped, empty fields omitted.

Run: uv run --with duckdb python scripts/compact.py [state ...]
"""

import json
import os
import sys
import time

import duckdb

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "addresses", "us")
OVERTURE = os.path.join(ROOT, "overture", "us.parquet")
OVERTURE_BY_STATE = os.path.join(ROOT, "overture", "by-state")
CENSUS = os.path.join(ROOT, "census")
BOUNDARIES = os.path.join(CENSUS, "boundaries.duckdb")
OUT = os.path.join(ROOT, "data", "addresses")

STATES = ("AL AK AZ AR CA CO CT DC DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV "
          "NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY").split()

# Census cartographic boundary files (https://www.census.gov/geographies/mapping-files.html).
CENSUS_FILES = {
    "zcta": "cb_2020_us_zcta520_500k",
    "place": "cb_2023_us_place_500k",
    "cousub": "cb_2023_us_cousub_500k",
}
# County subdivisions that people use as a town name: town, township, city, borough, village.
# The rest (census county divisions, precincts, unorganized territory) are statistical.
COUSUB_TOWN_LSAD = ("43", "44", "25", "21", "47")
NYC_BOROUGHS = ("Manhattan", "Bronx", "Brooklyn", "Queens", "Staten Island")

# The word lists are shared with the site's search (src/search.ts), which has to normalize
# typed text exactly the way stored streets are normalized here.
with open(os.path.join(ROOT, "scripts", "normalize.json")) as f:
    RULES = json.load(f)

# Sources spell the same street differently ("8th Avenue" vs "8TH AVE"), so every token is
# mapped to its USPS abbreviation before comparing. Applied to all tokens, not just the
# last: over-abbreviating "NORTH ST" to "N ST" is harmless next to missing a duplicate.
ABBREVIATIONS: dict[str, str] = RULES["abbreviations"]

# Ordinal street names come as "5TH", "FIFTH", "05TH", "12ND" and, mostly in New York, a bare
# "5 AVE". All become "5TH". Spelled ordinals are mapped as tokens; "TWENTY FIRST" is then
# joined into "21ST"; digits get their suffix recomputed. A bare number only counts as an
# ordinal when a street type follows it, so "HWY 5" and "10 MILE RD" are left alone.
UNIT_ORDINALS: list[str] = RULES["unitOrdinals"]
TEENS: list[str] = RULES["teens"]
TENS: list[str] = RULES["tens"]
BARE_ORDINAL_TYPES: list[str] = RULES["bareOrdinalTypes"]


def ordinal(n: int) -> str:
    suffix = "TH" if n % 100 in (11, 12, 13) else {1: "ST", 2: "ND", 3: "RD"}.get(n % 10, "TH")
    return f"{n}{suffix}"


ORDINAL_WORDS = {w: ordinal(i + 1) for i, w in enumerate(UNIT_ORDINALS)}
ORDINAL_WORDS |= {w: ordinal(i + 10) for i, w in enumerate(TEENS)}
ORDINAL_WORDS |= {t[:-1] + "IETH": ordinal(20 + 10 * i) for i, t in enumerate(TENS)}

ABBREVIATE = "CASE t " + " ".join(
    f"WHEN '{k}' THEN '{v}'" for k, v in (ABBREVIATIONS | ORDINAL_WORDS).items()
) + " ELSE t END"


def cleaned(col: str) -> str:
    return f"regexp_replace(regexp_replace(upper(trim({col})), '[.,#|]', '', 'g'), '\\s+', ' ', 'g')"


def city_cleaned(col: str) -> str:
    """cleaned(), minus the legal-name prefix some sources carry ("CITY OF EL PASO")."""
    return f"regexp_replace({cleaned(col)}, '^(CITY|TOWN|VILLAGE|TOWNSHIP|BOROUGH) OF ', '')"


def normalized(col: str) -> str:
    return f"array_to_string(list_transform(string_split({cleaned(col)}, ' '), t -> {ABBREVIATE}), ' ')"


def street_tokens(col: str) -> str:
    """The street as abbreviated tokens with ordinals spelled as digits; see ORDINAL_WORDS."""
    units = "|".join(UNIT_ORDINALS)
    s = f"regexp_replace({cleaned(col)}, '({'|'.join(TENS)})-({units})', '\\1 \\2', 'g')"
    s = f"array_to_string(list_transform(string_split({s}, ' '), t -> {ABBREVIATE}), ' ')"
    for i, tens in enumerate(TENS):
        s = f"regexp_replace({s}, '(^| ){tens} ([1-9](ST|ND|RD|TH))( |$)', '\\1{i + 2}\\2\\4', 'g')"
    return f"string_split({s}, ' ')"


def ordinalized(toks: str) -> str:
    """Rejoin street_tokens(), recomputing the suffix of every numeric ordinal."""
    n = "try_cast(regexp_extract(t, '^0*([1-9][0-9]*)', 1) as bigint)"
    suffixed = (f"{n}::varchar || case when {n} % 100 between 11 and 13 then 'TH' "
                f"when {n} % 10 = 1 then 'ST' when {n} % 10 = 2 then 'ND' "
                f"when {n} % 10 = 3 then 'RD' else 'TH' end")
    types = ", ".join(f"'{t}'" for t in BARE_ORDINAL_TYPES)
    return f"""array_to_string(list_transform({toks}, (t, i) -> coalesce(case
        when regexp_matches(t, '^0*[1-9][0-9]*(ST|ND|RD|TH)$') then {suffixed}
        when regexp_matches(t, '^0*[1-9][0-9]*$') and {toks}[i + 1] in ({types}) then {suffixed}
        end, t)), ' ')"""


def ensure_boundaries() -> None:
    """Load the Census shapefiles into a DuckDB file once; later runs just attach it."""
    if os.path.exists(BOUNDARIES):
        return
    con = duckdb.connect(BOUNDARIES + ".tmp")
    con.execute("install spatial; load spatial")
    for table, name in CENSUS_FILES.items():
        shp = f"/vsizip/{CENSUS}/{name}.zip/{name}.shp"
        cols = "ZCTA5CE20 as zip" if table == "zcta" else "NAME as name, STUSPS as state, LSAD as lsad"
        con.execute(f"create table {table} as select {cols}, geom from st_read('{shp}')")
    con.close()
    os.replace(BOUNDARIES + ".tmp", BOUNDARIES)


def ensure_overture_by_state() -> None:
    """Split overture/us.parquet by state once, so each state reads only its own rows."""
    if os.path.exists(OVERTURE_BY_STATE):
        return
    tmp = OVERTURE_BY_STATE + ".tmp"
    duckdb.execute(f"""
        copy (select *, address_levels[1].value as state from '{OVERTURE}')
        to '{tmp}' (format parquet, partition_by (state), compression zstd)
    """)
    os.replace(tmp, OVERTURE_BY_STATE)


def compact_state(con: duckdb.DuckDBPyConnection, state: str) -> tuple[int, int]:
    region = state.upper()
    sources = []

    pattern = os.path.join(SRC, state, "*-addresses-*.geojson")
    if os.path.isdir(os.path.join(SRC, state)):
        sources.append(f"""
        select properties.number as number, properties.street as street, properties.unit as unit,
          properties.city as city, properties.postcode as postcode,
          geometry.coordinates[1] as lon, geometry.coordinates[2] as lat
        from read_json('{pattern}', format = 'newline_delimited',
          columns = {{
            'properties': 'STRUCT(number VARCHAR, street VARCHAR, unit VARCHAR, city VARCHAR, postcode VARCHAR)',
            'geometry': 'STRUCT(coordinates DOUBLE[])'
          }})""")
    overture = os.path.join(OVERTURE_BY_STATE, f"state={region}")
    if os.path.isdir(overture):
        # postal_city is the mailing city (NAD); the second address level is the
        # municipality (Overture's OpenAddresses rows).
        sources.append(f"""
        select number, street, unit, coalesce(postal_city, address_levels[2].value) as city,
          postcode, lon, lat
        from read_parquet('{overture}/*.parquet')""")

    con.execute(f"""
        create or replace temp table raw as
        with src as ({" union all ".join(sources)}),
        parsed as (
        select
          upper(trim(number)) as number,
          {street_tokens('street')} as street_toks,
          {normalized('unit')} as unit,
          {city_cleaned('city')} as city,
          case when regexp_matches(trim(postcode), '^[0-9]{{5}}')
               then left(trim(postcode), 5) else '' end as postcode,
          lon, lat
        from src
        where trim(number) not in ('', '0')
          and regexp_matches(street, '[A-Za-z0-9]')
          and lon is not null
        )
        select number, {ordinalized('street_toks')} as street, coalesce(unit, '') as unit,
          coalesce(city, '') as city, postcode, lon, lat
        from parsed
    """)
    read = con.execute("select count(*) from raw").fetchone()[0]

    # A duplicate is the same number + street + unit within a ~0.1° (~11 km) cell: the
    # cell keeps "100 MAIN ST" in two different towns apart, while tolerating the metres
    # of disagreement between sources. Of each duplicate group, keep the row with the most
    # of city/postcode filled in.
    con.execute("""
        create or replace temp table dedup as
        select row_number() over () as id, number, street, unit, city, postcode, lon, lat
        from raw
        qualify row_number() over (
          partition by number, street, unit, round(lat, 1), round(lon, 1)
          order by (city <> '')::int + (postcode <> '')::int desc, city, postcode
        ) = 1
    """)

    # Fill what's still missing from the Census boundary each point falls in. ZIP code
    # tabulation areas match the real ZIP for ~99% of addresses that have one. For the city,
    # a Census place wins; outside places, the town or township.
    #
    # New York City is one Census place, and its sources call every address "New York", but
    # only Manhattan's mail says so: the other four boroughs' addresses are written as
    # "Brooklyn", "Bronx" and so on. So there a "NEW YORK" city is replaced by the borough.
    con.execute(f"""
        create or replace temp table zip_fill as
        select d.id, any_value(z.zip) as zip
        from dedup d join b.zcta z on st_contains(z.geom, st_point(d.lon, d.lat))
        where d.postcode = ''
        group by d.id
    """)
    boroughs = tuple(b for b in NYC_BOROUGHS if b != "Manhattan")
    con.execute(f"""
        create or replace temp table city_fill as
        with need as (
          select id, lon, lat from dedup
          where city = '' or ('{region}' = 'NY' and city = 'NEW YORK')
        ),
        place as (
          select n.id, any_value(p.name) as name
          from need n join (select * from b.place where state = '{region}') p
            on st_contains(p.geom, st_point(n.lon, n.lat))
          group by n.id
        ),
        town as (
          select n.id, any_value(c.name) as name
          from need n join (select * from b.cousub where state = '{region}'
                             and lsad in {COUSUB_TOWN_LSAD}) c
            on st_contains(c.geom, st_point(n.lon, n.lat))
          group by n.id
        ),
        joined as (
          select n.id, place.name as place, town.name as town,
            coalesce('{region}' = 'NY' and place.name = 'New York' and town.name in {boroughs}, false)
              as borough
          from need n left join place using (id) left join town using (id)
        )
        select id, upper(case when borough then town else coalesce(place, town) end) as city, borough
        from joined
    """)
    rows = con.execute("""
        select number, street, unit,
          case when c.borough then c.city else coalesce(nullif(d.city, ''), c.city, '') end as city,
          coalesce(nullif(d.postcode, ''), z.zip, '') as postcode
        from dedup d left join zip_fill z using (id) left join city_fill c using (id)
        order by postcode, city, street,
          try_cast(regexp_extract(number, '^[0-9]+') as bigint), number, unit
    """)

    written = 0
    tmp = os.path.join(OUT, f"{state}.ndjson.tmp")
    with open(tmp, "w") as f:
        while batch := rows.fetchmany(100_000):
            for number, street, unit, city, postcode in batch:
                # The sort key. Sorting by street alone put all 450k "MAIN ST" addresses in one
                # 40 MB block, since zonemapdb never splits equal keys; with the city and state in
                # the key they spread over normal-size blocks in town order, and a search that
                # names the town reads just one. "|" is stripped from every field by cleaned().
                record = {"key": f"{street}|{city}|{region}", "number": number, "street": street}
                if unit:
                    record["unit"] = unit
                if city:
                    record["city"] = city
                if postcode:
                    record["postcode"] = postcode
                record["state"] = region
                f.write(json.dumps(record, separators=(",", ":")))
                f.write("\n")
            written += len(batch)
    os.replace(tmp, os.path.join(OUT, f"{state}.ndjson"))
    return read, written


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    ensure_boundaries()
    ensure_overture_by_state()
    states = sys.argv[1:] or [s.lower() for s in STATES]
    con = duckdb.connect()
    con.execute(f"install spatial; load spatial; attach '{BOUNDARIES}' as b (read_only)")
    total_read = total_written = 0
    for state in states:
        start = time.time()
        read, written = compact_state(con, state)
        total_read += read
        total_written += written
        print(f"{state}: {read:>11,} read → {written:>11,} unique  ({time.time() - start:.0f}s)", flush=True)
    print(f"total: {total_read:,} read → {total_written:,} unique")


if __name__ == "__main__":
    main()
