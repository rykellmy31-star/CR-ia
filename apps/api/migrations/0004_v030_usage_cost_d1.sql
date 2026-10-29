-- CR IA v0.3.0 — custo real por evento de uso (OpenRouter usage.cost, USD).
-- Aplicar UMA vez: wrangler d1 execute --file migrations/0004_v030_usage_cost_d1.sql
-- (se acusar "duplicate column", já estava aplicado — pode ignorar.)
ALTER TABLE usage_events ADD COLUMN cost_usd REAL;
