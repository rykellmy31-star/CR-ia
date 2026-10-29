-- CR IA v0.3.0 — custo real por evento de uso (OpenRouter usage.cost, USD).
-- Aditivo e idempotente: não altera nem remove nada existente.
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS cost_usd DOUBLE PRECISION;
