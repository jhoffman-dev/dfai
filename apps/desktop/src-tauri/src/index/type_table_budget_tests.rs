//! #919: the Meeting table came back "interrupted" in a vault of a few
//! thousand imported meetings. These run what the app runs to open a type's
//! table (`runView`, `compileViewQuery`) over the Meeting type's view
//! (`typeViewSelectSql`), at sizes past today's vault, under the query budget.
//! The SQL is TypeScript's, copied here and held to it by
//! `packages/application/src/query/type-table-budget.pin.test.ts`.

use super::*;
use rusqlite::StatementStatus;

/// The built-in Meeting type's view: every property it declares and DFAI
/// ships on it, plus four a person added (`attendees`, `follow_up`, `rating`,
/// `topics`), as `viewSpecsFor` writes it.
const MEETING_VIEW: &str = r#"SELECT n.path AS "path",
       COALESCE((SELECT MAX(CASE WHEN p.key = 'title' THEN p.value_text END) FROM props AS p WHERE p.path = n.path AND p.key = 'title' AND COALESCE(p.value_text, p.value_json, '') <> ''), n.title) AS "title",
       n.summary AS "summary",
       n.modified AS "modified", n.progress AS "progress", (SELECT substr(min(CASE WHEN p.key = 'date' AND p.value_date IS NOT NULL THEN (p.idx * 4294967296 + p.rowid + 1000000000000000000) || p.value_date END), 20) FROM props AS p WHERE p.path = n.path AND p.key = 'date' AND COALESCE(p.value_text, p.value_json, '') <> '') AS "date", (SELECT CASE WHEN count(CASE WHEN p.key = 'start' THEN 1 END) = 1 THEN max(CASE WHEN p.key = 'start' THEN p.value_text END) END FROM props AS p WHERE p.path = n.path AND p.key = 'start' AND COALESCE(p.value_text, p.value_json, '') <> '') AS "start", (SELECT CASE WHEN count(CASE WHEN p.key = 'end' THEN 1 END) = 1 THEN max(CASE WHEN p.key = 'end' THEN p.value_text END) END FROM props AS p WHERE p.path = n.path AND p.key = 'end' AND COALESCE(p.value_text, p.value_json, '') <> '') AS "end", (SELECT CASE WHEN count(CASE WHEN p.key = 'kind' THEN 1 END) = 1 THEN max(CASE WHEN p.key = 'kind' THEN p.value_text END) END FROM props AS p WHERE p.path = n.path AND p.key = 'kind' AND COALESCE(p.value_text, p.value_json, '') <> '') AS "kind", (SELECT CASE WHEN count(CASE WHEN p.key = 'provider' THEN 1 END) = 1 THEN max(CASE WHEN p.key = 'provider' THEN p.value_text END) END FROM props AS p WHERE p.path = n.path AND p.key = 'provider' AND COALESCE(p.value_text, p.value_json, '') <> '') AS "provider", (SELECT CASE WHEN count(CASE WHEN p.key = 'external_id' THEN 1 END) = 1 THEN max(CASE WHEN p.key = 'external_id' THEN p.value_text END) END FROM props AS p WHERE p.path = n.path AND p.key = 'external_id' AND COALESCE(p.value_text, p.value_json, '') <> '') AS "external_id", (SELECT group_concat(p.value_text, ', ' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = 'people' AND p.value_text <> '') AS "people", (SELECT group_concat(p.value_text, ', ' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = 'companies' AND p.value_text <> '') AS "companies", (SELECT substr(min(CASE WHEN p.key = 'project' THEN (p.idx * 4294967296 + p.rowid + 1000000000000000000) || p.value_text END), 20) FROM props AS p WHERE p.path = n.path AND p.key = 'project' AND COALESCE(p.value_text, p.value_json, '') <> '') AS "project", (SELECT group_concat(p.value_text, ', ' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = 'tasks' AND p.value_text <> '') AS "tasks", (SELECT group_concat(p.value_text, ', ' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = 'decisions' AND p.value_text <> '') AS "decisions", (SELECT CASE WHEN count(CASE WHEN p.key = 'atlas_import_outcome' THEN 1 END) = 1 THEN max(CASE WHEN p.key = 'atlas_import_outcome' THEN p.value_text END) END FROM props AS p WHERE p.path = n.path AND p.key = 'atlas_import_outcome' AND COALESCE(p.value_text, p.value_json, '') <> '') AS "atlas_import_outcome", (SELECT CASE WHEN count(CASE WHEN p.key = 'atlas_import_error' THEN 1 END) = 1 THEN max(CASE WHEN p.key = 'atlas_import_error' THEN p.value_text END) END FROM props AS p WHERE p.path = n.path AND p.key = 'atlas_import_error' AND COALESCE(p.value_text, p.value_json, '') <> '') AS "atlas_import_error", (SELECT substr(min(CASE WHEN p.key = 'atlas_duplicate_of' THEN (p.idx * 4294967296 + p.rowid + 1000000000000000000) || p.value_text END), 20) FROM props AS p WHERE p.path = n.path AND p.key = 'atlas_duplicate_of' AND COALESCE(p.value_text, p.value_json, '') <> '') AS "atlas_duplicate_of", (SELECT group_concat(p.value_text, ', ' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = 'attendees' AND p.value_text <> '') AS "attendees", (SELECT substr(min(CASE WHEN p.key = 'follow_up' AND p.value_date IS NOT NULL THEN (p.idx * 4294967296 + p.rowid + 1000000000000000000) || p.value_date END), 20) FROM props AS p WHERE p.path = n.path AND p.key = 'follow_up' AND COALESCE(p.value_text, p.value_json, '') <> '') AS "follow_up", (SELECT CASE WHEN count(CASE WHEN p.key = 'rating' THEN 1 END) = 1 THEN max(CASE WHEN p.key = 'rating' THEN p.value_text END) END FROM props AS p WHERE p.path = n.path AND p.key = 'rating' AND COALESCE(p.value_text, p.value_json, '') <> '') AS "rating", (SELECT group_concat(p.value_text, ', ' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = 'topics' AND p.value_text <> '') AS "topics", (SELECT CASE WHEN count(CASE WHEN p.key = 'atlas_summary_digest' THEN 1 END) = 1 THEN max(CASE WHEN p.key = 'atlas_summary_digest' THEN p.value_text END) END FROM props AS p WHERE p.path = n.path AND p.key = 'atlas_summary_digest' AND COALESCE(p.value_text, p.value_json, '') <> '') AS "atlas_summary_digest", (SELECT CASE WHEN count(CASE WHEN p.key = 'atlas_summary_of' THEN 1 END) = 1 THEN max(CASE WHEN p.key = 'atlas_summary_of' THEN p.value_text END) END FROM props AS p WHERE p.path = n.path AND p.key = 'atlas_summary_of' AND COALESCE(p.value_text, p.value_json, '') <> '') AS "atlas_summary_of", (SELECT CASE WHEN count(CASE WHEN p.key = 'atlas_summary_model' THEN 1 END) = 1 THEN max(CASE WHEN p.key = 'atlas_summary_model' THEN p.value_text END) END FROM props AS p WHERE p.path = n.path AND p.key = 'atlas_summary_model' AND COALESCE(p.value_text, p.value_json, '') <> '') AS "atlas_summary_model"
FROM files AS n
WHERE n.path IN (SELECT path FROM props WHERE key = 'type' AND lower(trim(value_text)) = 'meeting')"#;

/// A small type sharing the meetings' list keys (#929): twenty books.
const BOOK_VIEW: &str = r#"SELECT n.path AS "path",
       COALESCE((SELECT MAX(CASE WHEN p.key = 'title' THEN p.value_text END) FROM props AS p WHERE p.path = n.path AND p.key = 'title' AND COALESCE(p.value_text, p.value_json, '') <> ''), n.title) AS "title",
       n.summary AS "summary",
       n.modified AS "modified", n.progress AS "progress", (SELECT group_concat(p.value_text, ', ' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = 'people' AND p.value_text <> '') AS "people", (SELECT group_concat(p.value_text, ', ' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = 'companies' AND p.value_text <> '') AS "companies"
FROM files AS n
WHERE n.path IN (SELECT path FROM props WHERE key = 'type' AND lower(trim(value_text)) = 'book')"#;

/// What opening the Meeting table runs (`typeTableQuery`): every column, by title, 500 rows.
const MEETING_TABLE: &str = r#"SELECT "path", "title", "date", "start", "end", "kind", "provider", "external_id", "people", "companies", "project", "tasks", "decisions", "atlas_import_outcome", "atlas_import_error", "atlas_duplicate_of", "attendees", "follow_up", "rating", "topics", "atlas_summary_digest", "atlas_summary_of", "atlas_summary_model"
FROM "v_meeting"
WHERE "path" IN (SELECT "path" FROM "v_meeting" WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/'
  ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC
  LIMIT ?)
ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC"#;

/// The table after a click on Date's header, twice: newest first.
const MEETING_TABLE_BY_DATE: &str = r#"SELECT "path", "title", "date", "start", "end", "kind", "provider", "external_id", "people", "companies", "project", "tasks", "decisions", "atlas_import_outcome", "atlas_import_error", "atlas_duplicate_of", "attendees", "follow_up", "rating", "topics", "atlas_summary_digest", "atlas_summary_of", "atlas_summary_model"
FROM "v_meeting"
WHERE "path" IN (SELECT "path" FROM "v_meeting" WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/'
  ORDER BY NULLIF("date", '') DESC NULLS LAST, "path" ASC
  LIMIT ?)
ORDER BY NULLIF("date", '') DESC NULLS LAST, "path" ASC"#;

/// A saved view of the meetings someone was in, by start time: every meeting
/// matches, Mara Quill being in each (#923).
const MEETING_TABLE_FILTERED: &str = r#"SELECT "path", "title", "date", "start", "end", "kind", "provider", "external_id", "people", "companies", "project", "tasks", "decisions", "atlas_import_outcome", "atlas_import_error", "atlas_duplicate_of", "attendees", "follow_up", "rating", "topics", "atlas_summary_digest", "atlas_summary_of", "atlas_summary_model"
FROM "v_meeting"
WHERE "path" IN (SELECT "path" FROM "v_meeting" WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/' AND CASE WHEN (SELECT instr(sql, '(SELECT group_concat(p.value_text, '', '' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = ''people'' AND p.value_text <> '''') AS "people"') > 0 FROM sqlite_master WHERE type = 'view' AND name = 'v_meeting' COLLATE NOCASE) THEN EXISTS (SELECT 1 FROM props AS p WHERE p.path = "v_meeting"."path" AND p.key = ? AND p.value_text <> '' AND p.value_text LIKE '%' || ? || '%') ELSE "people" LIKE '%' || ? || '%' END
  ORDER BY NULLIF("start", '') ASC NULLS LAST, "path" ASC
  LIMIT ?)
ORDER BY NULLIF("start", '') ASC NULLS LAST, "path" ASC"#;

/// contains, no meeting matching.
const MEETING_CONTAINS_NONE: &str = r#"SELECT "path", "title", "date", "start", "end", "kind", "provider", "external_id", "people", "companies", "project", "tasks", "decisions", "atlas_import_outcome", "atlas_import_error", "atlas_duplicate_of", "attendees", "follow_up", "rating", "topics", "atlas_summary_digest", "atlas_summary_of", "atlas_summary_model"
FROM "v_meeting"
WHERE "path" IN (SELECT "path" FROM "v_meeting" WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/' AND CASE WHEN (SELECT instr(sql, '(SELECT group_concat(p.value_text, '', '' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = ''people'' AND p.value_text <> '''') AS "people"') > 0 FROM sqlite_master WHERE type = 'view' AND name = 'v_meeting' COLLATE NOCASE) THEN EXISTS (SELECT 1 FROM props AS p WHERE p.path = "v_meeting"."path" AND p.key = ? AND p.value_text <> '' AND p.value_text LIKE '%' || ? || '%') ELSE "people" LIKE '%' || ? || '%' END
  ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC
  LIMIT ?)
ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC"#;

/// A saved view filtered by two list columns at once (#923).
const MEETING_TABLE_TWO_LIST_FILTERS: &str = r#"SELECT "path", "title", "date", "start", "end", "kind", "provider", "external_id", "people", "companies", "project", "tasks", "decisions", "atlas_import_outcome", "atlas_import_error", "atlas_duplicate_of", "attendees", "follow_up", "rating", "topics", "atlas_summary_digest", "atlas_summary_of", "atlas_summary_model"
FROM "v_meeting"
WHERE "path" IN (SELECT "path" FROM "v_meeting" WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/' AND CASE WHEN (SELECT instr(sql, '(SELECT group_concat(p.value_text, '', '' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = ''people'' AND p.value_text <> '''') AS "people"') > 0 FROM sqlite_master WHERE type = 'view' AND name = 'v_meeting' COLLATE NOCASE) THEN EXISTS (SELECT 1 FROM props AS p WHERE p.path = "v_meeting"."path" AND p.key = ? AND p.value_text <> '' AND p.value_text LIKE '%' || ? || '%') ELSE "people" LIKE '%' || ? || '%' END AND CASE WHEN (SELECT instr(sql, '(SELECT group_concat(p.value_text, '', '' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = ''tasks'' AND p.value_text <> '''') AS "tasks"') > 0 FROM sqlite_master WHERE type = 'view' AND name = 'v_meeting' COLLATE NOCASE) THEN EXISTS (SELECT 1 FROM props AS p WHERE p.path = "v_meeting"."path" AND p.key = ? AND p.value_text <> '' AND p.value_text LIKE '%' || ? || '%') ELSE "tasks" LIKE '%' || ? || '%' END
  ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC
  LIMIT ?)
ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC"#;

/// A list `is` a link, compared as text (no link resolver): no meeting matching,
/// as each holds two people or more (#923).
const MEETING_TABLE_PERSON_IS: &str = r#"SELECT "path", "title", "date", "start", "end", "kind", "provider", "external_id", "people", "companies", "project", "tasks", "decisions", "atlas_import_outcome", "atlas_import_error", "atlas_duplicate_of", "attendees", "follow_up", "rating", "topics", "atlas_summary_digest", "atlas_summary_of", "atlas_summary_model"
FROM "v_meeting"
WHERE "path" IN (SELECT "path" FROM "v_meeting" WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/' AND CASE WHEN (SELECT instr(sql, '(SELECT group_concat(p.value_text, '', '' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = ''people'' AND p.value_text <> '''') AS "people"') > 0 FROM sqlite_master WHERE type = 'view' AND name = 'v_meeting' COLLATE NOCASE) THEN EXISTS (SELECT 1 FROM props AS p WHERE p.path = "v_meeting"."path" AND p.key = ? AND p.value_text = ? AND NOT EXISTS (SELECT 1 FROM props AS q WHERE q.path = p.path AND q.key = p.key AND q.value_text <> '' AND q.rowid <> p.rowid)) ELSE "people" IS ? END
  ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC
  LIMIT ?)
ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC"#;

/// A list `is` its one item, every meeting matching.
const MEETING_IS_ALL: &str = r#"SELECT "path", "title", "date", "start", "end", "kind", "provider", "external_id", "people", "companies", "project", "tasks", "decisions", "atlas_import_outcome", "atlas_import_error", "atlas_duplicate_of", "attendees", "follow_up", "rating", "topics", "atlas_summary_digest", "atlas_summary_of", "atlas_summary_model"
FROM "v_meeting"
WHERE "path" IN (SELECT "path" FROM "v_meeting" WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/' AND CASE WHEN (SELECT instr(sql, '(SELECT group_concat(p.value_text, '', '' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = ''companies'' AND p.value_text <> '''') AS "companies"') > 0 FROM sqlite_master WHERE type = 'view' AND name = 'v_meeting' COLLATE NOCASE) THEN EXISTS (SELECT 1 FROM props AS p WHERE p.path = "v_meeting"."path" AND p.key = ? AND p.value_text = ? AND NOT EXISTS (SELECT 1 FROM props AS q WHERE q.path = p.path AND q.key = p.key AND q.value_text <> '' AND q.rowid <> p.rowid)) ELSE "companies" IS ? END
  ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC
  LIMIT ?)
ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC"#;

/// A list `is not` one item, every meeting matching (each holds two or more).
const MEETING_IS_NOT_ALL: &str = r#"SELECT "path", "title", "date", "start", "end", "kind", "provider", "external_id", "people", "companies", "project", "tasks", "decisions", "atlas_import_outcome", "atlas_import_error", "atlas_duplicate_of", "attendees", "follow_up", "rating", "topics", "atlas_summary_digest", "atlas_summary_of", "atlas_summary_model"
FROM "v_meeting"
WHERE "path" IN (SELECT "path" FROM "v_meeting" WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/' AND CASE WHEN (SELECT instr(sql, '(SELECT group_concat(p.value_text, '', '' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = ''people'' AND p.value_text <> '''') AS "people"') > 0 FROM sqlite_master WHERE type = 'view' AND name = 'v_meeting' COLLATE NOCASE) THEN NOT EXISTS (SELECT 1 FROM props AS p WHERE p.path = "v_meeting"."path" AND p.key = ? AND p.value_text = ? AND NOT EXISTS (SELECT 1 FROM props AS q WHERE q.path = p.path AND q.key = p.key AND q.value_text <> '' AND q.rowid <> p.rowid)) ELSE "people" IS NOT ? END
  ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC
  LIMIT ?)
ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC"#;

/// A list `is not` its one item, no meeting matching.
const MEETING_IS_NOT_NONE: &str = r#"SELECT "path", "title", "date", "start", "end", "kind", "provider", "external_id", "people", "companies", "project", "tasks", "decisions", "atlas_import_outcome", "atlas_import_error", "atlas_duplicate_of", "attendees", "follow_up", "rating", "topics", "atlas_summary_digest", "atlas_summary_of", "atlas_summary_model"
FROM "v_meeting"
WHERE "path" IN (SELECT "path" FROM "v_meeting" WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/' AND CASE WHEN (SELECT instr(sql, '(SELECT group_concat(p.value_text, '', '' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = ''companies'' AND p.value_text <> '''') AS "companies"') > 0 FROM sqlite_master WHERE type = 'view' AND name = 'v_meeting' COLLATE NOCASE) THEN NOT EXISTS (SELECT 1 FROM props AS p WHERE p.path = "v_meeting"."path" AND p.key = ? AND p.value_text = ? AND NOT EXISTS (SELECT 1 FROM props AS q WHERE q.path = p.path AND q.key = p.key AND q.value_text <> '' AND q.rowid <> p.rowid)) ELSE "companies" IS NOT ? END
  ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC
  LIMIT ?)
ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC"#;

/// The meetings with no tasks: a list column `is empty` (#923).
const MEETING_TABLE_WITHOUT_TASKS: &str = r#"SELECT "path", "title", "date", "start", "end", "kind", "provider", "external_id", "people", "companies", "project", "tasks", "decisions", "atlas_import_outcome", "atlas_import_error", "atlas_duplicate_of", "attendees", "follow_up", "rating", "topics", "atlas_summary_digest", "atlas_summary_of", "atlas_summary_model"
FROM "v_meeting"
WHERE "path" IN (SELECT "path" FROM "v_meeting" WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/' AND CASE WHEN (SELECT instr(sql, '(SELECT group_concat(p.value_text, '', '' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = ''tasks'' AND p.value_text <> '''') AS "tasks"') > 0 FROM sqlite_master WHERE type = 'view' AND name = 'v_meeting' COLLATE NOCASE) THEN NOT EXISTS (SELECT 1 FROM props AS p WHERE p.path = "v_meeting"."path" AND p.key = ? AND p.value_text <> '') ELSE ("tasks" IS NULL OR "tasks" = '') END
  ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC
  LIMIT ?)
ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC"#;

/// A list no meeting holds, `is empty`: every meeting matching.
const MEETING_IS_EMPTY_ALL: &str = r#"SELECT "path", "title", "date", "start", "end", "kind", "provider", "external_id", "people", "companies", "project", "tasks", "decisions", "atlas_import_outcome", "atlas_import_error", "atlas_duplicate_of", "attendees", "follow_up", "rating", "topics", "atlas_summary_digest", "atlas_summary_of", "atlas_summary_model"
FROM "v_meeting"
WHERE "path" IN (SELECT "path" FROM "v_meeting" WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/' AND CASE WHEN (SELECT instr(sql, '(SELECT group_concat(p.value_text, '', '' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = ''decisions'' AND p.value_text <> '''') AS "decisions"') > 0 FROM sqlite_master WHERE type = 'view' AND name = 'v_meeting' COLLATE NOCASE) THEN NOT EXISTS (SELECT 1 FROM props AS p WHERE p.path = "v_meeting"."path" AND p.key = ? AND p.value_text <> '') ELSE ("decisions" IS NULL OR "decisions" = '') END
  ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC
  LIMIT ?)
ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC"#;

/// A list every meeting holds, `is empty`: none matching.
const MEETING_IS_EMPTY_NONE: &str = r#"SELECT "path", "title", "date", "start", "end", "kind", "provider", "external_id", "people", "companies", "project", "tasks", "decisions", "atlas_import_outcome", "atlas_import_error", "atlas_duplicate_of", "attendees", "follow_up", "rating", "topics", "atlas_summary_digest", "atlas_summary_of", "atlas_summary_model"
FROM "v_meeting"
WHERE "path" IN (SELECT "path" FROM "v_meeting" WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/' AND CASE WHEN (SELECT instr(sql, '(SELECT group_concat(p.value_text, '', '' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = ''people'' AND p.value_text <> '''') AS "people"') > 0 FROM sqlite_master WHERE type = 'view' AND name = 'v_meeting' COLLATE NOCASE) THEN NOT EXISTS (SELECT 1 FROM props AS p WHERE p.path = "v_meeting"."path" AND p.key = ? AND p.value_text <> '') ELSE ("people" IS NULL OR "people" = '') END
  ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC
  LIMIT ?)
ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC"#;

/// A list every meeting holds, `is not empty`.
const MEETING_IS_NOT_EMPTY_ALL: &str = r#"SELECT "path", "title", "date", "start", "end", "kind", "provider", "external_id", "people", "companies", "project", "tasks", "decisions", "atlas_import_outcome", "atlas_import_error", "atlas_duplicate_of", "attendees", "follow_up", "rating", "topics", "atlas_summary_digest", "atlas_summary_of", "atlas_summary_model"
FROM "v_meeting"
WHERE "path" IN (SELECT "path" FROM "v_meeting" WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/' AND CASE WHEN (SELECT instr(sql, '(SELECT group_concat(p.value_text, '', '' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = ''people'' AND p.value_text <> '''') AS "people"') > 0 FROM sqlite_master WHERE type = 'view' AND name = 'v_meeting' COLLATE NOCASE) THEN EXISTS (SELECT 1 FROM props AS p WHERE p.path = "v_meeting"."path" AND p.key = ? AND p.value_text <> '') ELSE ("people" IS NOT NULL AND "people" <> '') END
  ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC
  LIMIT ?)
ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC"#;

/// A list no meeting holds, `is not empty`.
const MEETING_IS_NOT_EMPTY_NONE: &str = r#"SELECT "path", "title", "date", "start", "end", "kind", "provider", "external_id", "people", "companies", "project", "tasks", "decisions", "atlas_import_outcome", "atlas_import_error", "atlas_duplicate_of", "attendees", "follow_up", "rating", "topics", "atlas_summary_digest", "atlas_summary_of", "atlas_summary_model"
FROM "v_meeting"
WHERE "path" IN (SELECT "path" FROM "v_meeting" WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/' AND CASE WHEN (SELECT instr(sql, '(SELECT group_concat(p.value_text, '', '' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = ''decisions'' AND p.value_text <> '''') AS "decisions"') > 0 FROM sqlite_master WHERE type = 'view' AND name = 'v_meeting' COLLATE NOCASE) THEN EXISTS (SELECT 1 FROM props AS p WHERE p.path = "v_meeting"."path" AND p.key = ? AND p.value_text <> '') ELSE ("decisions" IS NOT NULL AND "decisions" <> '') END
  ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC
  LIMIT ?)
ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC"#;

/// startsWith, every meeting matching: still the cell's filter (#929).
const MEETING_STARTS_WITH_ALL: &str = r#"SELECT "path", "title", "date", "start", "end", "kind", "provider", "external_id", "people", "companies", "project", "tasks", "decisions", "atlas_import_outcome", "atlas_import_error", "atlas_duplicate_of", "attendees", "follow_up", "rating", "topics", "atlas_summary_digest", "atlas_summary_of", "atlas_summary_model"
FROM "v_meeting"
WHERE "path" IN (SELECT "path" FROM "v_meeting" WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/' AND "people" LIKE ? || '%'
  ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC
  LIMIT ?)
ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC"#;

/// The table after a click on People's header, twice: a list column, sorted by its joined cell.
const MEETING_SORT_BY_PEOPLE: &str = r#"SELECT "path", "title", "date", "start", "end", "kind", "provider", "external_id", "people", "companies", "project", "tasks", "decisions", "atlas_import_outcome", "atlas_import_error", "atlas_duplicate_of", "attendees", "follow_up", "rating", "topics", "atlas_summary_digest", "atlas_summary_of", "atlas_summary_model"
FROM "v_meeting"
WHERE "path" IN (SELECT "path" FROM "v_meeting" WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/'
  ORDER BY NULLIF("people", '') DESC NULLS LAST, "path" ASC
  LIMIT ?)
ORDER BY NULLIF("people", '') DESC NULLS LAST, "path" ASC"#;

/// Sorted by two list columns, each by its joined cell: the statement of the
/// attack on #921 (`type-table-budget.attack-921.test.ts`).
const MEETING_SORT_BY_TWO_LISTS: &str = r#"SELECT "path", "title", "date", "start", "end", "kind", "provider", "external_id", "people", "companies", "project", "tasks", "decisions", "atlas_import_outcome", "atlas_import_error", "atlas_duplicate_of", "attendees", "follow_up", "rating", "topics", "atlas_summary_digest", "atlas_summary_of", "atlas_summary_model"
FROM "v_meeting"
WHERE "path" IN (SELECT "path" FROM "v_meeting" WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/'
  ORDER BY NULLIF("people", '') DESC NULLS LAST, NULLIF("attendees", '') ASC NULLS LAST, "path" ASC
  LIMIT ?)
ORDER BY NULLIF("people", '') DESC NULLS LAST, NULLIF("attendees", '') ASC NULLS LAST, "path" ASC"#;

/// The sidebar's count of a quick view over meetings, and a dashboard's number widget.
const MEETING_COUNT: &str = r#"SELECT COUNT(*) AS "value"
FROM "v_meeting"
WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/'
LIMIT ?"#;

/// The same count of a view filtered by a list column (#923).
const MEETING_COUNT_FILTERED: &str = r#"SELECT COUNT(*) AS "value"
FROM "v_meeting"
WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/' AND CASE WHEN (SELECT instr(sql, '(SELECT group_concat(p.value_text, '', '' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = ''people'' AND p.value_text <> '''') AS "people"') > 0 FROM sqlite_master WHERE type = 'view' AND name = 'v_meeting' COLLATE NOCASE) THEN EXISTS (SELECT 1 FROM props AS p WHERE p.path = "v_meeting"."path" AND p.key = ? AND p.value_text <> '' AND p.value_text LIKE '%' || ? || '%') ELSE "people" LIKE '%' || ? || '%' END
LIMIT ?"#;

/// A dashboard's chart of meetings by kind.
const MEETING_GROUPS: &str = r#"SELECT COALESCE("kind", '') AS "label", COUNT(*) AS "count"
FROM "v_meeting"
WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/'
GROUP BY COALESCE("kind", '')
ORDER BY "count" DESC, "label" ASC
LIMIT ?"#;

/// A dashboard's chart of meetings by their people: one group per joined cell.
const MEETING_GROUPS_BY_PEOPLE: &str = r#"SELECT COALESCE("people", '') AS "label", COUNT(*) AS "count"
FROM "v_meeting"
WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/'
GROUP BY COALESCE("people", '')
ORDER BY "count" DESC, "label" ASC
LIMIT ?"#;

/// The same chart of a view filtered by a list column (#923).
const MEETING_GROUPS_BY_PEOPLE_FILTERED: &str = r#"SELECT COALESCE("people", '') AS "label", COUNT(*) AS "count"
FROM "v_meeting"
WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/' AND CASE WHEN (SELECT instr(sql, '(SELECT group_concat(p.value_text, '', '' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = ''people'' AND p.value_text <> '''') AS "people"') > 0 FROM sqlite_master WHERE type = 'view' AND name = 'v_meeting' COLLATE NOCASE) THEN EXISTS (SELECT 1 FROM props AS p WHERE p.path = "v_meeting"."path" AND p.key = ? AND p.value_text <> '' AND p.value_text LIKE '%' || ? || '%') ELSE "people" LIKE '%' || ? || '%' END
GROUP BY COALESCE("people", '')
ORDER BY "count" DESC, "label" ASC
LIMIT ?"#;

/// The books' table, filtered by a list the meetings share: contains.
const BOOK_CONTAINS: &str = r#"SELECT "path", "title", "people", "companies"
FROM "v_book"
WHERE "path" IN (SELECT "path" FROM "v_book" WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/' AND CASE WHEN (SELECT instr(sql, '(SELECT group_concat(p.value_text, '', '' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = ''people'' AND p.value_text <> '''') AS "people"') > 0 FROM sqlite_master WHERE type = 'view' AND name = 'v_book' COLLATE NOCASE) THEN EXISTS (SELECT 1 FROM props AS p WHERE p.path = "v_book"."path" AND p.key = ? AND p.value_text <> '' AND p.value_text LIKE '%' || ? || '%') ELSE "people" LIKE '%' || ? || '%' END
  ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC
  LIMIT ?)
ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC"#;

/// The books, `is` one person.
const BOOK_IS: &str = r#"SELECT "path", "title", "people", "companies"
FROM "v_book"
WHERE "path" IN (SELECT "path" FROM "v_book" WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/' AND CASE WHEN (SELECT instr(sql, '(SELECT group_concat(p.value_text, '', '' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = ''people'' AND p.value_text <> '''') AS "people"') > 0 FROM sqlite_master WHERE type = 'view' AND name = 'v_book' COLLATE NOCASE) THEN EXISTS (SELECT 1 FROM props AS p WHERE p.path = "v_book"."path" AND p.key = ? AND p.value_text = ? AND NOT EXISTS (SELECT 1 FROM props AS q WHERE q.path = p.path AND q.key = p.key AND q.value_text <> '' AND q.rowid <> p.rowid)) ELSE "people" IS ? END
  ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC
  LIMIT ?)
ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC"#;

/// The books, `is not` one person.
const BOOK_IS_NOT: &str = r#"SELECT "path", "title", "people", "companies"
FROM "v_book"
WHERE "path" IN (SELECT "path" FROM "v_book" WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/' AND CASE WHEN (SELECT instr(sql, '(SELECT group_concat(p.value_text, '', '' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = ''people'' AND p.value_text <> '''') AS "people"') > 0 FROM sqlite_master WHERE type = 'view' AND name = 'v_book' COLLATE NOCASE) THEN NOT EXISTS (SELECT 1 FROM props AS p WHERE p.path = "v_book"."path" AND p.key = ? AND p.value_text = ? AND NOT EXISTS (SELECT 1 FROM props AS q WHERE q.path = p.path AND q.key = p.key AND q.value_text <> '' AND q.rowid <> p.rowid)) ELSE "people" IS NOT ? END
  ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC
  LIMIT ?)
ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC"#;

/// The books, people `is empty`.
const BOOK_IS_EMPTY: &str = r#"SELECT "path", "title", "people", "companies"
FROM "v_book"
WHERE "path" IN (SELECT "path" FROM "v_book" WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/' AND CASE WHEN (SELECT instr(sql, '(SELECT group_concat(p.value_text, '', '' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = ''people'' AND p.value_text <> '''') AS "people"') > 0 FROM sqlite_master WHERE type = 'view' AND name = 'v_book' COLLATE NOCASE) THEN NOT EXISTS (SELECT 1 FROM props AS p WHERE p.path = "v_book"."path" AND p.key = ? AND p.value_text <> '') ELSE ("people" IS NULL OR "people" = '') END
  ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC
  LIMIT ?)
ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC"#;

/// The books, people `is not empty`.
const BOOK_IS_NOT_EMPTY: &str = r#"SELECT "path", "title", "people", "companies"
FROM "v_book"
WHERE "path" IN (SELECT "path" FROM "v_book" WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/' AND CASE WHEN (SELECT instr(sql, '(SELECT group_concat(p.value_text, '', '' ORDER BY p.idx, p.rowid) FROM props AS p WHERE p.path = n.path AND p.key = ''people'' AND p.value_text <> '''') AS "people"') > 0 FROM sqlite_master WHERE type = 'view' AND name = 'v_book' COLLATE NOCASE) THEN EXISTS (SELECT 1 FROM props AS p WHERE p.path = "v_book"."path" AND p.key = ? AND p.value_text <> '') ELSE ("people" IS NOT NULL AND "people" <> '') END
  ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC
  LIMIT ?)
ORDER BY NULLIF("title", '') ASC NULLS LAST, "path" ASC"#;

/// Each statement the tests run, with what it binds.
fn statements() -> Vec<(&'static str, &'static str, Vec<serde_json::Value>)> {
    let limit = || serde_json::json!(500);
    let text = |value: &str| serde_json::json!(value);
    vec![
        ("meeting_table", MEETING_TABLE, vec![limit()]),
        (
            "meeting_table_by_date",
            MEETING_TABLE_BY_DATE,
            vec![limit()],
        ),
        (
            "meeting_table_filtered",
            MEETING_TABLE_FILTERED,
            vec![text("people"), text("Mara"), text("Mara"), limit()],
        ),
        (
            "meeting_contains_none",
            MEETING_CONTAINS_NONE,
            vec![text("people"), text("Zed"), text("Zed"), limit()],
        ),
        (
            "meeting_table_two_list_filters",
            MEETING_TABLE_TWO_LIST_FILTERS,
            vec![
                text("people"),
                text("Mara"),
                text("Mara"),
                text("tasks"),
                text("Follow"),
                text("Follow"),
                limit(),
            ],
        ),
        (
            "meeting_table_person_is",
            MEETING_TABLE_PERSON_IS,
            vec![
                text("people"),
                text("[[Mara Quill]]"),
                text("[[Mara Quill]]"),
                limit(),
            ],
        ),
        (
            "meeting_is_all",
            MEETING_IS_ALL,
            vec![
                text("companies"),
                text("[[Larkspur Payroll]]"),
                text("[[Larkspur Payroll]]"),
                limit(),
            ],
        ),
        (
            "meeting_is_not_all",
            MEETING_IS_NOT_ALL,
            vec![
                text("people"),
                text("[[Mara Quill]]"),
                text("[[Mara Quill]]"),
                limit(),
            ],
        ),
        (
            "meeting_is_not_none",
            MEETING_IS_NOT_NONE,
            vec![
                text("companies"),
                text("[[Larkspur Payroll]]"),
                text("[[Larkspur Payroll]]"),
                limit(),
            ],
        ),
        (
            "meeting_table_without_tasks",
            MEETING_TABLE_WITHOUT_TASKS,
            vec![text("tasks"), limit()],
        ),
        (
            "meeting_is_empty_all",
            MEETING_IS_EMPTY_ALL,
            vec![text("decisions"), limit()],
        ),
        (
            "meeting_is_empty_none",
            MEETING_IS_EMPTY_NONE,
            vec![text("people"), limit()],
        ),
        (
            "meeting_is_not_empty_all",
            MEETING_IS_NOT_EMPTY_ALL,
            vec![text("people"), limit()],
        ),
        (
            "meeting_is_not_empty_none",
            MEETING_IS_NOT_EMPTY_NONE,
            vec![text("decisions"), limit()],
        ),
        (
            "meeting_starts_with_all",
            MEETING_STARTS_WITH_ALL,
            vec![text("[["), limit()],
        ),
        (
            "meeting_sort_by_people",
            MEETING_SORT_BY_PEOPLE,
            vec![limit()],
        ),
        (
            "meeting_sort_by_two_lists",
            MEETING_SORT_BY_TWO_LISTS,
            vec![limit()],
        ),
        ("meeting_count", MEETING_COUNT, vec![limit()]),
        (
            "meeting_count_filtered",
            MEETING_COUNT_FILTERED,
            vec![text("people"), text("Mara"), text("Mara"), limit()],
        ),
        ("meeting_groups", MEETING_GROUPS, vec![limit()]),
        (
            "meeting_groups_by_people",
            MEETING_GROUPS_BY_PEOPLE,
            vec![limit()],
        ),
        (
            "meeting_groups_by_people_filtered",
            MEETING_GROUPS_BY_PEOPLE_FILTERED,
            vec![text("people"), text("Mara"), text("Mara"), limit()],
        ),
        (
            "book_contains",
            BOOK_CONTAINS,
            vec![text("people"), text("Mara"), text("Mara"), limit()],
        ),
        (
            "book_is",
            BOOK_IS,
            vec![
                text("people"),
                text("[[Mara Quill]]"),
                text("[[Mara Quill]]"),
                limit(),
            ],
        ),
        (
            "book_is_not",
            BOOK_IS_NOT,
            vec![
                text("people"),
                text("[[Mara Quill]]"),
                text("[[Mara Quill]]"),
                limit(),
            ],
        ),
        (
            "book_is_empty",
            BOOK_IS_EMPTY,
            vec![text("people"), limit()],
        ),
        (
            "book_is_not_empty",
            BOOK_IS_NOT_EMPTY,
            vec![text("people"), limit()],
        ),
    ]
}

const TITLES: [&str; 6] = [
    "Larkspur Payroll sync",
    "Weekly standup",
    "1:1 Mara Quill",
    "Hiring loop",
    "Roadmap review",
    "Tobias Fenn / onboarding",
];
const KINDS: [&str; 4] = ["Standup", "1:1", "Review", ""];

fn text(key: &str, index: i64, value: &str) -> IndexedProperty {
    IndexedProperty {
        key: key.into(),
        index,
        text: Some(value.into()),
        number: None,
        date: None,
        json: None,
    }
}

fn day(key: &str, value: &str) -> IndexedProperty {
    IndexedProperty {
        date: Some(value.into()),
        ..text(key, 0, value)
    }
}

fn object(key: &str, index: i64, json: String) -> IndexedProperty {
    IndexedProperty {
        text: None,
        json: Some(json),
        ..text(key, index, "")
    }
}

fn related(key: &str, index: i64, target: &str) -> IndexedRelation {
    IndexedRelation {
        key: key.into(),
        index,
        target: target.into(),
        name: target.to_lowercase(),
        path: Some(format!("{target}.md")),
    }
}

/// A meeting as the Granola and Calendar imports write one (`meeting-to-atlas.ts`,
/// `event-notes.ts`), and as summarising and filing it leave it: its header,
/// two to eight attendees, each a person linked, a company, often a project
/// and tasks. Titles recur, as a weekly meeting's does, so sorts meet ties.
fn meeting(at: usize) -> IndexedNote {
    let title = TITLES[at % TITLES.len()];
    let date = format!("2026-{:02}-{:02}", at % 12 + 1, at % 28 + 1);
    let path = format!("Inbox/Meetings/{date} {title} {at:05}.md");
    let mut properties = vec![
        text("type", 0, "meeting"),
        text("atlas_import", 0, "meeting/v1"),
        text("title", 0, title),
        day("date", &date),
        text("start", 0, &format!("{:02}:30", 8 + at % 9)),
        text("start_source", 0, "calendar"),
        text("end", 0, &format!("{:02}:00", 9 + at % 9)),
        text(
            "provider",
            0,
            if at % 3 == 0 {
                "google-calendar"
            } else {
                "granola"
            },
        ),
        text("external_id", 0, &format!("evt-{at:06}")),
        text(
            "source_url",
            0,
            &format!("https://example.com/meetings/{at}"),
        ),
        text("transcript_clock", 0, "elapsed"),
        text("atlas_import_outcome", 0, "imported"),
        text("gcal_event_id", 0, &format!("gcal-{at:06}")),
        text("gcal_calendar", 0, "mara@example.com"),
        text("atlas_summary_digest", 0, &format!("{at:064x}")),
        text("atlas_summary_of", 0, "granola"),
        text("atlas_summary_model", 0, "claude"),
        text("companies", 0, "[[Larkspur Payroll]]"),
    ];
    let kind = KINDS[at % KINDS.len()];
    if !kind.is_empty() {
        properties.push(text("kind", 0, kind));
    }
    let mut relations = vec![related("companies", 0, "Larkspur Payroll")];
    for person in 0..(2 + at % 7) as i64 {
        let name = if person == 0 {
            "Mara Quill".to_string()
        } else {
            format!("Tobias Fenn {}", (at as i64 + person) % 40)
        };
        properties.push(object(
            "attendees",
            person,
            format!(r#"{{"name":"{name}","email":"person{person}@example.com"}}"#),
        ));
        properties.push(text("people", person, &format!("[[{name}]]")));
        relations.push(related("people", person, &name));
    }
    if at % 3 == 0 {
        properties.push(text("project", 0, "[[Larkspur launch]]"));
        relations.push(related("project", 0, "Larkspur launch"));
    }
    if at % 2 == 0 {
        for task in 0..2 {
            let name = format!("Follow up {at} {task}");
            properties.push(text("tasks", task, &format!("[[{name}]]")));
            relations.push(related("tasks", task, &name));
        }
    }
    IndexedNote {
        path,
        title: title.into(),
        modified: 1_790_000_000_000 + at as u64,
        size: 2_000,
        digest: String::new(),
        note_type: Some("meeting".into()),
        body: "Notes from the meeting. Mara Quill walked through the Larkspur Payroll rollout."
            .into(),
        summary: "Notes from the meeting.".into(),
        properties,
        links: Vec::new(),
        tags: Vec::new(),
        relations,
        blocks: Vec::new(),
        checks: Vec::new(),
        progress: None,
        highlights: Vec::new(),
    }
}

/// How many books every vault holds beside its meetings (#929).
const BOOKS: usize = 20;

/// A book naming a person and a company, as a meeting does.
fn book(at: usize) -> IndexedNote {
    IndexedNote {
        path: format!("Books/Book {at:02}.md"),
        title: format!("Book {at:02}"),
        properties: vec![
            text("type", 0, "book"),
            text("people", 0, "[[Mara Quill]]"),
            text("companies", 0, "[[Larkspur Payroll]]"),
        ],
        relations: Vec::new(),
        body: String::new(),
        summary: String::new(),
        note_type: Some("book".into()),
        ..meeting(at)
    }
}

/// An index of `count` meetings and twenty books, with each type's view made.
fn vault_of(count: usize) -> (tempfile::TempDir, IndexState) {
    let vault = tempfile::tempdir().unwrap();
    let index = IndexState::default();
    index.open(vault.path()).unwrap();
    let mut notes: Vec<IndexedNote> = (0..count).map(meeting).collect();
    notes.extend((0..BOOKS).map(book));
    index.put(None, &notes).unwrap();
    let specs = [
        TypeSpec {
            name: "meeting".into(),
            select: MEETING_VIEW.into(),
        },
        TypeSpec {
            name: "book".into(),
            select: BOOK_VIEW.into(),
        },
    ];
    index
        .with_connection(|connection| rebuild_views(connection, &specs))
        .unwrap();
    (vault, index)
}

/// How many virtual-machine steps `sql` takes to run to its last row, unbounded.
fn steps_of(root: &Path, sql: &str, parameters: &[serde_json::Value]) -> i32 {
    let connection = Connection::open_with_flags(
        database_path(root).unwrap(),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let mut statement = connection.prepare(sql).unwrap();
    let bound: Vec<rusqlite::types::Value> = parameters
        .iter()
        .map(|value| match value {
            serde_json::Value::Number(number) => number.as_i64().unwrap().into(),
            other => other.as_str().unwrap().to_string().into(),
        })
        .collect();
    let mut rows = statement
        .query(rusqlite::params_from_iter(bound.iter()))
        .unwrap();
    while rows.next().unwrap().is_some() {}
    drop(rows);
    statement.get_status(StatementStatus::VmStep)
}

/// The reproduction table: steps per statement at each size. Slow, so run on
/// demand: `cargo test type_table_budget -- --ignored --nocapture`.
#[test]
#[ignore]
fn steps_per_statement_by_vault_size() {
    eprintln!(
        "meetings | {}",
        statements()
            .iter()
            .map(|(name, ..)| *name)
            .collect::<Vec<_>>()
            .join(" | ")
    );
    for count in [50, 300, 500, 1_000, 2_000, 5_000, 10_000, 20_000] {
        let (vault, _index) = vault_of(count);
        let steps: Vec<String> = statements()
            .iter()
            .map(|(_, sql, parameters)| steps_of(vault.path(), sql, parameters).to_string())
            .collect();
        eprintln!("{count} | {}", steps.join(" | "));
    }
}

/// How much a statement may cost, as a slope and a ceiling: `per_note` is the
/// most steps each meeting past 5,000 may add (measured between 5,000 and
/// 20,000, so growth is caught as a slope, whatever the vault's size), and
/// `share` the most of the budget it may take at 20,000.
struct Bound {
    statement: &'static str,
    per_note: i32,
    share: f64,
}

const BOUNDS: [Bound; 22] = [
    // Opening the table: the page's own rows plus each note's sort cell, about 73 a note.
    Bound {
        statement: MEETING_TABLE,
        per_note: 100,
        share: 0.5,
    },
    // The same by a single-valued column other than the title: about 83 a note.
    Bound {
        statement: MEETING_TABLE_BY_DATE,
        per_note: 100,
        share: 0.5,
    },
    // A count reads no cell: about 18 a note.
    Bound {
        statement: MEETING_COUNT,
        per_note: 25,
        share: 0.1,
    },
    // A list filter asks each note's own items, never its joined cell (#923,
    // #929): contains with every meeting matching, about 104 a note (main: 200).
    Bound {
        statement: MEETING_TABLE_FILTERED,
        per_note: 130,
        share: 0.6,
    },
    // contains with none matching: about 89 a note.
    Bound {
        statement: MEETING_CONTAINS_NONE,
        per_note: 110,
        share: 0.45,
    },
    // Two list filters: about 101 a note.
    Bound {
        statement: MEETING_TABLE_TWO_LIST_FILTERS,
        per_note: 130,
        share: 0.6,
    },
    // `is`, none matching: a seek on the note's value, about 82 a note.
    Bound {
        statement: MEETING_TABLE_PERSON_IS,
        per_note: 105,
        share: 0.5,
    },
    // `is`, every meeting matching: the seek and a look for a second item, about 111 a note.
    Bound {
        statement: MEETING_IS_ALL,
        per_note: 130,
        share: 0.6,
    },
    // `is not`, every meeting matching: about 118 a note.
    Bound {
        statement: MEETING_IS_NOT_ALL,
        per_note: 145,
        share: 0.75,
    },
    // `is not`, none matching: about 75 a note.
    Bound {
        statement: MEETING_IS_NOT_NONE,
        per_note: 90,
        share: 0.35,
    },
    // `is empty`, half matching: about 73 a note.
    Bound {
        statement: MEETING_TABLE_WITHOUT_TASKS,
        per_note: 90,
        share: 0.45,
    },
    // `is empty`, every meeting matching: about 91 a note.
    Bound {
        statement: MEETING_IS_EMPTY_ALL,
        per_note: 110,
        share: 0.55,
    },
    // `is empty`, none matching: about 58 a note.
    Bound {
        statement: MEETING_IS_EMPTY_NONE,
        per_note: 75,
        share: 0.3,
    },
    // `is not empty`, every meeting matching: about 95 a note.
    Bound {
        statement: MEETING_IS_NOT_EMPTY_ALL,
        per_note: 115,
        share: 0.55,
    },
    // `is not empty`, none matching: about 54 a note.
    Bound {
        statement: MEETING_IS_NOT_EMPTY_NONE,
        per_note: 70,
        share: 0.3,
    },
    // startsWith stays the cell's filter (#929): about 173 a note.
    Bound {
        statement: MEETING_STARTS_WITH_ALL,
        per_note: 210,
        share: 0.9,
    },
    // A sort on a list column still joins each note's cell, which its order is
    // made of; read from its items alone (#923), about 141 a note.
    Bound {
        statement: MEETING_SORT_BY_PEOPLE,
        per_note: 175,
        share: 0.8,
    },
    // Two list sorts join two cells a note: about 186 a note, near 0.83 of the
    // budget at 20,000 — not improved by #923 beyond the cheaper cell.
    Bound {
        statement: MEETING_SORT_BY_TWO_LISTS,
        per_note: 225,
        share: 0.95,
    },
    // A count of a view filtered by a list: about 43 a note.
    Bound {
        statement: MEETING_COUNT_FILTERED,
        per_note: 55,
        share: 0.25,
    },
    // A chart by a single-valued column: about 61 a note.
    Bound {
        statement: MEETING_GROUPS,
        per_note: 75,
        share: 0.35,
    },
    // A chart by a list column groups by each note's joined cell: about 127 a note.
    Bound {
        statement: MEETING_GROUPS_BY_PEOPLE,
        per_note: 155,
        share: 0.65,
    },
    // The same chart, filtered by a list: about 152 a note.
    Bound {
        statement: MEETING_GROUPS_BY_PEOPLE_FILTERED,
        per_note: 185,
        share: 0.75,
    },
];

/// The books' statements: a small type's table, held by `a_small_type_costs_per_note_of_its_own`.
const BOOK_STATEMENTS: [&str; 5] = [
    BOOK_CONTAINS,
    BOOK_IS,
    BOOK_IS_NOT,
    BOOK_IS_EMPTY,
    BOOK_IS_NOT_EMPTY,
];

/// The guard (#919, #923): each statement's cost per meeting, between 5,000
/// and 20,000 meetings, and its share of the budget at 20,000, within its bound.
#[test]
fn a_type_table_costs_a_bounded_number_of_steps_per_note() {
    let (small, _small_index) = vault_of(5_000);
    let (large, large_index) = vault_of(20_000);
    for (name, sql, parameters) in statements() {
        if BOOK_STATEMENTS.contains(&sql) {
            continue;
        }
        let answered = large_index.query(large.path(), sql, &parameters);
        assert!(answered.is_ok(), "{name}: {answered:?}");
        let bound = BOUNDS
            .iter()
            .find(|bound| bound.statement == sql)
            .unwrap_or_else(|| panic!("{name} has no bound"));
        let at_small = steps_of(small.path(), sql, &parameters);
        let at_large = steps_of(large.path(), sql, &parameters);
        let per_note = (at_large - at_small) / 15_000;
        assert!(
            per_note <= bound.per_note,
            "{name}: {per_note} steps a meeting ({at_small} at 5,000, {at_large} at 20,000), past {}",
            bound.per_note
        );
        let share = f64::from(at_large) / f64::from(QUERY_STEP_BUDGET);
        assert!(
            share < bound.share,
            "{name}: {at_large} steps at 20,000 is {share:.2} of the budget, past {}",
            bound.share
        );
        eprintln!("{name}: {per_note} a meeting; {at_small} at 5,000, {at_large} at 20,000");
    }
}

/// A small type's table filtered by a list a large type shares (#929): it
/// asks only its own notes' items, so it costs the same beside no meetings,
/// 5,000 or 20,000, and a few thousand steps in all.
#[test]
fn a_small_type_costs_per_note_of_its_own() {
    let vaults = [0, 5_000, 20_000].map(vault_of);
    for (name, sql, parameters) in statements() {
        if !BOOK_STATEMENTS.contains(&sql) {
            continue;
        }
        let steps = vaults
            .each_ref()
            .map(|(vault, _)| steps_of(vault.path(), sql, &parameters));
        let [alone, ..] = steps;
        assert!(alone < 10_000, "{name}: {alone} steps for {BOOKS} books");
        for at in steps {
            assert!(
                (at - alone).abs() < 500,
                "{name}: {steps:?} steps beside 0, 5,000 and 20,000 meetings"
            );
        }
        eprintln!("{name}: {steps:?} beside 0, 5,000 and 20,000 meetings");
    }
}
