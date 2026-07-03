CREATE TABLE IF NOT EXISTS metric_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  source_language TEXT,
  target_language TEXT,
  duration_ms INTEGER,
  latency_ms INTEGER,
  input_events INTEGER,
  output_events INTEGER,
  audio_ms INTEGER,
  voice_chunks INTEGER,
  error_message TEXT,
  device TEXT,
  browser TEXT,
  country TEXT,
  details_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_metric_events_created_at_ms ON metric_events(created_at_ms);
CREATE INDEX IF NOT EXISTS idx_metric_events_event_type ON metric_events(event_type, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_metric_events_session_id ON metric_events(session_id, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_metric_events_languages ON metric_events(source_language, target_language, created_at_ms);
