-- Начальные данные магазинов для Дежурный MVP
-- Запускать ПОСЛЕ первого старта бэкенда (init_db создаст таблицы)
-- Команда: psql $DATABASE_URL -f backend/seed.sql

INSERT INTO stores (name, platform, default_roi, tax_rate, early_ship_discount, selling_program, payout_frequency, stock_min, stock_max)
VALUES
  ('yam16', 'Yandex Market', 0.3,  0.06, 0.0, 'FBS', 'DAILY',   20, 50),
  ('yam21', 'Yandex Market', 0.2,  0.06, 0.0, 'FBS', 'DAILY',   20, 50)
ON CONFLICT DO NOTHING;
