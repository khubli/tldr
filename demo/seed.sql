-- Demo data: fictional people and companies only (Contoso, Fabrikam,
-- Woodgrove Bank, Northwind). Times are relative to when the demo is built.
-- The reader's projects in this story: "ledger" (a small bookkeeping app)
-- and "harbor" (a self-hosted deploy tool).

INSERT INTO saves (id, source, source_id, url, title, author, text, saved_at, status) VALUES
 (1,  'x_bookmark', 'demo-1',  'https://x.com/fabrikam_eng/status/1001', NULL, '@fabrikam_eng', 'We open-sourced our eval harness: fixture runner, golden files, diff view.', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'), 'triaged'),
 (2,  'share',      'demo-2',  'https://blog.contoso.example/cron-notes', 'Contoso''s cron notes', NULL, 'What we learned running 400 cron jobs on one Worker.', strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'), 'triaged'),
 (3,  'x_bookmark', 'demo-3',  'https://x.com/woodgrove_design/status/1003', NULL, '@woodgrove_design', 'Why a 17px serif body beats 16px sans for long reads on a phone. Measurements from three apps inside.', strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'), 'triaged'),
 (4,  'x_bookmark', 'demo-4',  'https://x.com/contoso_dev/status/1004', NULL, '@contoso_dev', 'A 40-line D1 migration pattern: rename-and-copy in one batch, no downtime.', strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 days'), 'triaged'),
 (5,  'github_star','demo-5',  'https://github.com/northwind/queue-lite', 'northwind/queue-lite', 'northwind', 'A job queue on SQLite with retries and dead letters. 600 lines.', strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 days'), 'triaged'),
 (6,  'youtube',    'demo-6',  'https://www.youtube.com/watch?v=demo000006', 'Bookkeeping for people who hate bookkeeping', 'Woodgrove Bank', 'A 14-minute walk through double-entry with plain examples.', strftime('%Y-%m-%dT%H:%M:%fZ','now','-4 days'), 'triaged'),
 (7,  'x_bookmark', 'demo-7',  'https://x.com/fabrikam_ops/status/1007', NULL, '@fabrikam_ops', 'Our rollback button is a git tag and one command. Thread on why we stopped doing blue-green.', strftime('%Y-%m-%dT%H:%M:%fZ','now','-4 days'), 'triaged'),
 (8,  'share',      'demo-8',  'https://northwind.example/blog/csv-imports', 'CSV imports that never lose a row', NULL, 'Stage, validate, then swap. With the three bank formats that break everything.', strftime('%Y-%m-%dT%H:%M:%fZ','now','-5 days'), 'triaged'),
 (9,  'x_bookmark', 'demo-9',  'https://x.com/growth_guru_demo/status/1009', NULL, '@growth_guru_demo', '10 AI tools that will replace your whole team by Friday 🚀🚀', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'), 'triaged'),
 (10, 'x_bookmark', 'demo-10', 'https://x.com/hot_takes_demo/status/1010', NULL, '@hot_takes_demo', 'Unpopular opinion: nobody needs tests. Like and repost if you agree.', strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'), 'triaged'),
 (11, 'x_bookmark', 'demo-11', 'https://x.com/contoso_dev/status/1011', NULL, '@contoso_dev', 'Reminder: D1 migrations can rename and copy in one batch.', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'), 'triaged'),
 (12, 'paste',      'demo-12', NULL, NULL, NULL, 'Ask Woodgrove Bank about the API sandbox before the demo', strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 hours'), 'new'),
 (13, 'share',      'demo-13', 'https://blog.fabrikam.example/fridays', 'How Fabrikam ships on Fridays', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours'), 'new'),
 (14, 'x_bookmark', 'demo-14', 'https://x.com/northwind_eng/status/1014', NULL, '@northwind_eng', 'Postmortem: the cache that remembered too much.', strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days'), 'triaged');

INSERT INTO triage (save_id, verdict, spike_reason, headline, tldr, why_you, action_type, action_project, action_text, rank, tags, triaged_at) VALUES
 (1,  'keep',  NULL, 'Fabrikam open-sources its eval harness', 'Fixture runner plus golden files and a diff view; runs offline in about 2 seconds for 200 cases.', 'The ledger''s import tests need exactly this.', 'try', 'ledger', 'Run Fabrikam''s fixture runner against the ledger''s import tests', 88, '["testing","evals"]', strftime('%Y-%m-%dT%H:%M:%fZ','now','-20 hours')),
 (2,  'keep',  NULL, 'Contoso''s notes on 400 cron jobs in one Worker', 'Stagger by minute, keep each job idempotent, log one line per run.', 'Harbor''s scheduler is heading the same way.', 'read', 'harbor', 'Read Contoso''s cron notes before changing harbor''s scheduler', 81, '["cron","workers"]', strftime('%Y-%m-%dT%H:%M:%fZ','now','-44 hours')),
 (3,  'keep',  NULL, 'Woodgrove Bank''s design team on dense mobile type', 'Why a 17px serif body beats a 16px sans for long reads on a phone, with measurements from three apps.', 'The ledger''s reports are read on phones.', NULL, NULL, NULL, 77, '["design","typography"]', strftime('%Y-%m-%dT%H:%M:%fZ','now','-44 hours')),
 (4,  'keep',  NULL, 'A 40-line D1 migration pattern worth stealing', 'Rename-and-copy in one batch, no downtime.', 'You have two schema changes queued.', NULL, NULL, NULL, 72, '["d1","sql"]', strftime('%Y-%m-%dT%H:%M:%fZ','now','-68 hours')),
 (5,  'keep',  NULL, 'Northwind''s 600-line SQLite job queue', 'Retries with backoff and a dead-letter table; no external broker.', 'Could replace harbor''s ad-hoc retry loop.', 'apply', 'harbor', 'Swap harbor''s retry loop for queue-lite''s backoff table', 70, '["queues","sqlite"]', strftime('%Y-%m-%dT%H:%M:%fZ','now','-68 hours')),
 (6,  'keep',  NULL, 'Double-entry bookkeeping in 14 minutes', 'Every transaction touches two accounts; the video''s grocery example is the clearest version.', 'The ledger''s onboarding could borrow the example.', NULL, NULL, NULL, 64, '["accounting"]', strftime('%Y-%m-%dT%H:%M:%fZ','now','-92 hours')),
 (7,  'keep',  NULL, 'Fabrikam replaced blue-green with a tag and one command', 'Rollback is checking out the previous tag; they cut deploy time from 9 minutes to 2.', 'Harbor''s rollback is still manual.', NULL, NULL, NULL, 61, '["deploys"]', strftime('%Y-%m-%dT%H:%M:%fZ','now','-92 hours')),
 (8,  'keep',  NULL, 'CSV imports that never lose a row', 'Stage into a temp table, validate, then swap; three bank formats cause most failures.', 'The ledger imports bank CSVs.', NULL, NULL, NULL, 58, '["imports","csv"]', strftime('%Y-%m-%dT%H:%M:%fZ','now','-116 hours')),
 (9,  'spike', 'hype',   '"10 AI tools" listicle', NULL, NULL, NULL, NULL, NULL, 0, '[]', strftime('%Y-%m-%dT%H:%M:%fZ','now','-20 hours')),
 (10, 'spike', 'bait',   'Hot take on tests, built for reposts', NULL, NULL, NULL, NULL, NULL, 0, '[]', strftime('%Y-%m-%dT%H:%M:%fZ','now','-44 hours')),
 (11, 'spike', 'repost', 'Same D1 migration tip as Tuesday', NULL, NULL, NULL, NULL, NULL, 0, '[]', strftime('%Y-%m-%dT%H:%M:%fZ','now','-20 hours')),
 (14, 'keep',  NULL, 'Northwind''s cache postmortem', 'A cache keyed without the tenant id served one customer''s totals to another for 11 minutes.', 'The ledger caches report totals.', 'file', 'ledger', 'File Northwind''s cache postmortem in the ledger''s notes', 55, '["caching","postmortem"]', strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'));

INSERT INTO actions (save_id, state, due, updated_at) VALUES
 (1,  'open',    NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now','-20 hours')),
 (2,  'open',    NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now','-44 hours')),
 (5,  'snoozed', strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')),
 (14, 'done',    NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 days'));

INSERT INTO x_account (id, user_id, username, access_token, refresh_token, expires_at, backfill_done, last_sync_at, last_sync_added, connected_at) VALUES
 (1, '0', 'contoso_reader', 'demo-not-a-token', NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 days'), 1, strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 hours'), 4, strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days'));
