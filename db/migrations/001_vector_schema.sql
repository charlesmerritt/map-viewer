-- 001_vector_schema.sql — vector layer storage for pg_tileserv.
--
-- Everything pg_tileserv is allowed to publish lives in the `vector` schema and
-- nowhere else. The `tileserv` role gets USAGE on that schema and SELECT on its
-- tables, so adding a table here publishes it and adding one anywhere else does
-- not. See docs/adr/0001-postgis-pg-tileserv-for-vectors.md.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE SCHEMA IF NOT EXISTS vector;

-- Applied-migration bookkeeping. The runner reads this before each file.
CREATE TABLE IF NOT EXISTS vector.schema_migrations (
  filename    text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- Display metadata for published tables. pg_tileserv discovers geometry tables
-- on its own but knows nothing about titles, colours or which column to label a
-- feature with, so the viewer reads this registry to build its layer catalog.
CREATE TABLE IF NOT EXISTS vector.layer_registry (
  table_name     text PRIMARY KEY,
  title          text NOT NULL,
  description    text,
  geometry_type  text NOT NULL DEFAULT 'Polygon',
  id_column      text,
  label_column   text,
  attributes     jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_style  jsonb NOT NULL DEFAULT '{}'::jsonb,
  min_zoom       integer NOT NULL DEFAULT 0,
  max_zoom       integer NOT NULL DEFAULT 22,
  is_builtin     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- US state boundaries (Census CB 1:5,000,000, GENZ2022).
CREATE TABLE IF NOT EXISTS vector.us_states (
  statefp  text PRIMARY KEY,
  stusps   text NOT NULL,
  name     text NOT NULL,
  geom     geometry(MultiPolygon, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS us_states_geom_idx ON vector.us_states USING GIST (geom);

-- US county boundaries, same vintage as the states above.
CREATE TABLE IF NOT EXISTS vector.us_counties (
  geoid    text PRIMARY KEY,
  statefp  text NOT NULL,
  stusps   text NOT NULL,
  name     text NOT NULL,
  geom     geometry(MultiPolygon, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS us_counties_geom_idx ON vector.us_counties USING GIST (geom);
CREATE INDEX IF NOT EXISTS us_counties_statefp_idx ON vector.us_counties (statefp);

-- Read-only grants for the tile server. Applied to existing tables and, via
-- ALTER DEFAULT PRIVILEGES, to any table a later migration or an upload adds.
GRANT USAGE ON SCHEMA vector TO tileserv;
GRANT SELECT ON ALL TABLES IN SCHEMA vector TO tileserv;
ALTER DEFAULT PRIVILEGES IN SCHEMA vector GRANT SELECT ON TABLES TO tileserv;
