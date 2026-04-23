# Dezhurny MVP

SaaS система управления ценами и остатками для маркетплейсов  
(модель: дропшиппинг / работа от оптовых прайсов).

Текущая версия — MVP для двух магазинов Яндекс Маркета:

- yam16
- yam21

Система:

- загружает прайсы поставщиков
- сопоставляет их с ассортиментом магазинов
- рассчитывает цены на основе ROI
- обновляет цены и остатки через API маркетплейса

---

# Быстрый старт

## Docker (рекомендуется)

git clone https://github.com/lazylidd/Dezhurny.git  
cd Dezhurny  
cp .env.example .env  
docker compose up --build

Frontend: http://localhost  
Backend API docs: http://localhost:8000/docs

---

## Локальная разработка

1. Клонировать репозиторий

git clone https://github.com/lazylidd/Dezhurny.git  
cd Dezhurny

2. Создать env файл

cp .env.example .env

3. Запустить backend

cd backend  
pip install -r requirements.txt  
uvicorn main:app --reload

API документация: http://127.0.0.1:8000/docs

4. Запустить frontend

cd frontend  
npm install  
npm run dev

5. Запустить тесты

cd backend  
pytest

40 тестов: unit-тесты на price engine, matching service, auth; интеграционные тесты на FastAPI endpoints.

---

# Архитектура проекта

backend/  
    api/  
    database/  
    models/  
    parsers/  
    price_engine/  
    schemas/  
    services/  
    tasks/  
    utils/  
    main.py  

frontend/  
infra/  
docs/

---

# Назначение папок

## backend

Основная серверная часть системы (FastAPI).  
Отвечает за API, бизнес-логику, работу с базой данных и интеграцию с маркетплейсом.

---

## backend/api

HTTP endpoints системы.

Примеры:

- получение списка магазинов  
- получение ассортимента  
- загрузка прайсов  
- пересчет цен  

---

## backend/database

Подключение к базе данных.

Содержит:

- конфигурацию Postgres  
- инициализацию таблиц  

---

## backend/models

SQLAlchemy модели таблиц базы данных.

Основные таблицы системы:

- stores  
- products  
- supplier_prices  
- price_updates  

---

## backend/parsers

Парсеры оптовых прайсов.

Поддерживаются:

- Excel  
- PDF  

Извлекают:

- название товара  
- цену  

---

## backend/price_engine

Движок расчета цен.

Рассчитывает:

- себестоимость  
- ROI  
- комиссию маркетплейса  
- итоговую цену витрины  

---

## backend/services

Бизнес-логика системы.

Связывает:

- API  
- базу данных  
- price engine  
- парсеры  

---

## backend/schemas

Pydantic-схемы API.

Используются для:

- валидации данных  
- сериализации ответов  

---

## backend/tasks

Фоновые задачи системы.

Например:

- массовое обновление цен  
- обновление остатков  

---

## backend/utils

Вспомогательные функции.

Например:

- нормализация названий товаров  
- логирование  

---

## frontend

Frontend интерфейс системы.

Будет содержать:

- dashboard  
- страницу загрузки прайсов  
- страницы ассортимента магазинов  

---

## infra

Инфраструктура проекта.

Содержит:

- docker  
- nginx  
- deployment конфигурации  

---

## docs

Документация проекта:

- ТЗ  
- архитектура системы  
- технические заметки  

---

# Основные API endpoints (MVP)

GET /stores  
GET /stores/{store_id}/assortment  

POST /upload-prices  
POST /recalculate  

---

# Основной сценарий работы системы

1. Пользователь загружает прайсы поставщиков  
2. Система парсит файлы  
3. Данные сохраняются в supplier_prices  
4. Price engine рассчитывает новые цены  
5. Пользователь подтверждает обновления  
6. Система обновляет цены и остатки через API маркетплейса  
