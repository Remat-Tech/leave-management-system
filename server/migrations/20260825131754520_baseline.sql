-- Up Migration

-- Baseline. Brings an empty database under migration control.
--
-- No tables are created here. This migration exists to establish the starting
-- point every later migration builds on, and to enable the extensions the
-- schema depends on before any table needs them.
--
-- btree_gist lets a GiST exclusion constraint mix equality on a scalar column
-- with overlap on a range, which is how overlapping leave is prevented at the
-- database level rather than in application code. See the Technical Design
-- Document, section 4.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Down Migration

DROP EXTENSION IF EXISTS btree_gist;
