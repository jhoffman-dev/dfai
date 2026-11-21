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
       COALESCE(MAX(CASE WHEN p.key = 'title' THEN p.value_text END), n.title) AS "title",
       n.summary AS "summary",
       n.modified AS "modified", n.progress AS "progress", substr(min(CASE WHEN p.key = 'date' AND p.value_date IS NOT NULL THEN (p.idx * 4294967296 + p.rowid + 1000000000000000000) || p.value_date END), 20) AS "date", CASE WHEN count(CASE WHEN p.key = 'start' THEN 1 END) = 1 THEN max(CASE WHEN p.key = 'start' THEN p.value_text END) END AS "start", CASE WHEN count(CASE WHEN p.key = 'end' THEN 1 END) = 1 THEN max(CASE WHEN p.key = 'end' THEN p.value_text END) END AS "end", CASE WHEN count(CASE WHEN p.key = 'kind' THEN 1 END) = 1 THEN max(CASE WHEN p.key = 'kind' THEN p.value_text END) END AS "kind", CASE WHEN count(CASE WHEN p.key = 'provider' THEN 1 END) = 1 THEN max(CASE WHEN p.key = 'provider' THEN p.value_text END) END AS "provider", CASE WHEN count(CASE WHEN p.key = 'external_id' THEN 1 END) = 1 THEN max(CASE WHEN p.key = 'external_id' THEN p.value_text END) END AS "external_id", group_concat(CASE WHEN p.key = 'people' THEN p.value_text END, ', ' ORDER BY p.idx, p.rowid) AS "people", group_concat(CASE WHEN p.key = 'companies' THEN p.value_text END, ', ' ORDER BY p.idx, p.rowid) AS "companies", substr(min(CASE WHEN p.key = 'project' THEN (p.idx * 4294967296 + p.rowid + 1000000000000000000) || p.value_text END), 20) AS "project", group_concat(CASE WHEN p.key = 'tasks' THEN p.value_text END, ', ' ORDER BY p.idx, p.rowid) AS "tasks", group_concat(CASE WHEN p.key = 'decisions' THEN p.value_text END, ', ' ORDER BY p.idx, p.rowid) AS "decisions", CASE WHEN count(CASE WHEN p.key = 'atlas_import_outcome' THEN 1 END) = 1 THEN max(CASE WHEN p.key = 'atlas_import_outcome' THEN p.value_text END) END AS "atlas_import_outcome", CASE WHEN count(CASE WHEN p.key = 'atlas_import_error' THEN 1 END) = 1 THEN max(CASE WHEN p.key = 'atlas_import_error' THEN p.value_text END) END AS "atlas_import_error", substr(min(CASE WHEN p.key = 'atlas_duplicate_of' THEN (p.idx * 4294967296 + p.rowid + 1000000000000000000) || p.value_text END), 20) AS "atlas_duplicate_of", group_concat(CASE WHEN p.key = 'attendees' THEN p.value_text END, ', ' ORDER BY p.idx, p.rowid) AS "attendees", substr(min(CASE WHEN p.key = 'follow_up' AND p.value_date IS NOT NULL THEN (p.idx * 4294967296 + p.rowid + 1000000000000000000) || p.value_date END), 20) AS "follow_up", CASE WHEN count(CASE WHEN p.key = 'rating' THEN 1 END) = 1 THEN max(CASE WHEN p.key = 'rating' THEN p.value_text END) END AS "rating", group_concat(CASE WHEN p.key = 'topics' THEN p.value_text END, ', ' ORDER BY p.idx, p.rowid) AS "topics", CASE WHEN count(CASE WHEN p.key = 'atlas_summary_digest' THEN 1 END) = 1 THEN max(CASE WHEN p.key = 'atlas_summary_digest' THEN p.value_text END) END AS "atlas_summary_digest", CASE WHEN count(CASE WHEN p.key = 'atlas_summary_of' THEN 1 END) = 1 THEN max(CASE WHEN p.key = 'atlas_summary_of' THEN p.value_text END) END AS "atlas_summary_of", CASE WHEN count(CASE WHEN p.key = 'atlas_summary_model' THEN 1 END) = 1 THEN max(CASE WHEN p.key = 'atlas_summary_model' THEN p.value_text END) END AS "atlas_summary_model"
FROM files AS n JOIN props AS p ON p.path = n.path AND COALESCE(p.value_text, p.value_json, '') <> ''
WHERE n.path IN (SELECT path FROM props WHERE key = 'type' AND lower(trim(value_text)) = 'meeting')
GROUP BY n.path"#;

/// What opening the Meeting table runs (`typeTableQuery`): every column, by title, 500 rows.
const MEETING_TABLE: &str = r#"SELECT "path", "title", "date", "start", "end", "kind", "provider", "external_id", "people", "companies", "project", "tasks", "decisions", "atlas_import_outcome", "atlas_import_error", "atlas_duplicate_of", "attendees", "follow_up", "rating", "topics", "atlas_summary_digest", "atlas_summary_of", "atlas_summary_model"
FROM "v_meeting"
WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/'
ORDER BY "title" ASC, "path" ASC
LIMIT ?"#;

/// The table after a click on Date's header, twice: newest first.
const MEETING_TABLE_BY_DATE: &str = r#"SELECT "path", "title", "date", "start", "end", "kind", "provider", "external_id", "people", "companies", "project", "tasks", "decisions", "atlas_import_outcome", "atlas_import_error", "atlas_duplicate_of", "attendees", "follow_up", "rating", "topics", "atlas_summary_digest", "atlas_summary_of", "atlas_summary_model"
FROM "v_meeting"
WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/'
ORDER BY "date" DESC, "path" ASC
LIMIT ?"#;

/// A saved view of the meetings someone was in, by start time.
const MEETING_TABLE_FILTERED: &str = r#"SELECT "path", "title", "date", "start", "end", "kind", "provider", "external_id", "people", "companies", "project", "tasks", "decisions", "atlas_import_outcome", "atlas_import_error", "atlas_duplicate_of", "attendees", "follow_up", "rating", "topics", "atlas_summary_digest", "atlas_summary_of", "atlas_summary_model"
FROM "v_meeting"
WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/' AND "people" LIKE '%' || ? || '%'
ORDER BY "start" ASC, "path" ASC
LIMIT ?"#;

/// The sidebar's count of a quick view over meetings, and a dashboard's number widget.
const MEETING_COUNT: &str = r#"SELECT COUNT(*) AS "value"
FROM "v_meeting"
WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/'
LIMIT ?"#;

/// A dashboard's chart of meetings by kind.
const MEETING_GROUPS: &str = r#"SELECT COALESCE("kind", '') AS "label", COUNT(*) AS "count"
FROM "v_meeting"
WHERE substr("path", 1, 7) <> '.atlas/' AND lower(substr("path", 1, 8)) <> 'archive/'
GROUP BY COALESCE("kind", '')
ORDER BY "count" DESC, "label" ASC
LIMIT ?"#;

/// Each statement the tests run, with what it binds.
fn statements() -> [(&'static str, &'static str, Vec<serde_json::Value>); 5] {
    let limit = || serde_json::json!(500);
    [
        ("table, by title", MEETING_TABLE, vec![limit()]),
        ("table, by date desc", MEETING_TABLE_BY_DATE, vec![limit()]),
        (
            "view, filtered by person",
            MEETING_TABLE_FILTERED,
            vec![serde_json::json!("Mara"), limit()],
        ),
        ("count", MEETING_COUNT, vec![limit()]),
        ("groups by kind", MEETING_GROUPS, vec![limit()]),
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

/// An index of `count` meetings, with the Meeting type's view made.
fn vault_of(count: usize) -> (tempfile::TempDir, IndexState) {
    let vault = tempfile::tempdir().unwrap();
    let index = IndexState::default();
    index.open(vault.path()).unwrap();
    let meetings: Vec<IndexedNote> = (0..count).map(meeting).collect();
    index.put(None, &meetings).unwrap();
    let spec = TypeSpec {
        name: "meeting".into(),
        select: MEETING_VIEW.into(),
    };
    index
        .with_connection(|connection| rebuild_views(connection, &[spec]))
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
        statements().map(|(name, ..)| name).join(" | ")
    );
    for count in [500, 1_000, 2_000, 5_000, 10_000, 20_000] {
        let (vault, _index) = vault_of(count);
        let steps = statements()
            .map(|(_, sql, parameters)| steps_of(vault.path(), sql, &parameters).to_string());
        eprintln!("{count} | {}", steps.join(" | "));
    }
}

/// The guard: at 20,000 meetings, ten times a large vault today, each
/// statement a type's table, its counts and its charts run comes back, and
/// within half the budget, so the next columns a person adds still fit.
#[test]
fn a_type_table_opens_within_the_query_budget_at_twenty_thousand_meetings() {
    let (vault, index) = vault_of(20_000);
    for (name, sql, parameters) in statements() {
        let answered = index.query(vault.path(), sql, &parameters);
        assert!(answered.is_ok(), "{name}: {answered:?}");
        let steps = steps_of(vault.path(), sql, &parameters);
        assert!(
            steps < QUERY_STEP_BUDGET / 2,
            "{name} took {steps} of the {QUERY_STEP_BUDGET} steps a query may"
        );
    }
}
