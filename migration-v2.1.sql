-- Migration V2.1: Trip visibility + tilbagerul status
ALTER TABLE trips ADD COLUMN IF NOT EXISTS visibility text DEFAULT 'shared';
-- visibility: 'shared' (fælles) eller 'private' (privat)
