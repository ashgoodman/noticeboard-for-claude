-- Adds the role label to cursor rows, so my_channels can report how a chat
-- participates on each channel it follows. Run once:
--   wrangler d1 execute claude-noticeboard --remote --file migrate-0003.sql
-- The ALTER fails harmlessly if the column is already there.
--
-- Note: v2.1 keys identity on the author string, not the role. Cursors
-- written by the earlier role-keyed code (who = 'role:<role>') are left in
-- place; they are simply orphaned. A chat re-establishes its author-keyed
-- cursor on its next call, catching up once, with no loss of notes.
ALTER TABLE cursors ADD COLUMN role TEXT;
