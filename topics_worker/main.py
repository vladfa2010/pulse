"""
ТЗ-115, задача 2 — topics-worker: HDBSCAN-кластеризация эмбеддингов новостей.

Один прогон = одна строка topic_runs (running -> done | error).
Скрипт ничего не знает про LLM и бизнес-логику: читает news.embedding,
кластеризует, пишет topics / topic_items. Нейминг — Node-cron (04:10 МСК).

Пайплайн:
  1. INSERT topic_runs (status='running', params из env)
  2. Загрузка эмбеддингов окна (TOPICS_WINDOW_DAYS) + probe: shape (N, 1024) в лог
  3. L2-ренормализация строк (эмбеддинги Qwen3 нормализованы; после PCA
     нормировка слетает, а euclidean на нормированных векторах ~ cosine)
  4. PCA до TOPICS_PCA_DIMS компонент (сырые 1024-мерные вектора страдают
     от проклятия размерности; precomputed-матрица 42k×42k ≈ 14 ГБ — не строим)
  5. HDBSCAN (min_cluster_size / min_samples из env, metric='euclidean');
     шум = label -1, в таблицы не пишем, считаем noise_count
  6. Склейка с последним done-прогоном: Jaccard по news_id >=
     TOPICS_JACCARD_THRESHOLD -> наследуем prev_topic_id + name/summary
     (named=true сразу, LLM не дёргаем); один старый кластер наследует
     только один новый (максимальный overlap), проигравший — новая тема
  7. Статистика кластера: news_count, span_days, sources_count, daily по
     московским суткам (published_at AT TIME ZONE 'Europe/Moscow')::date,
     keywords = TF-IDF top-10 по title_ru || ' ' || summary_ru,
     trend = сумма последних 3 ПОЛНЫХ московских дней vs предыдущие 3
     (неполный текущий день не включаем; ±25%)
  8. is_core = membership_probabilities_ >= 0.5
  9. Запись ОДНОЙ транзакцией: topics + topic_items батчами по 1000 +
     UPDATE topic_runs SET status='done'. Любое исключение -> ROLLBACK +
     UPDATE topic_runs SET status='error' + non-zero exit (иначе упавший
     прогон оставил бы running навсегда).
"""

from __future__ import annotations

import json
import logging
import os
import sys
import traceback
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import hdbscan
import numpy as np
import psycopg
from pgvector.psycopg import register_vector
from sklearn.decomposition import PCA
from sklearn.feature_extraction.text import TfidfVectorizer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("topics-worker")

MSK = ZoneInfo("Europe/Moscow")

# Параметры прогона — только env, тюнинг без правки кода (ТЗ-115 §4)
WINDOW_DAYS = int(os.environ.get("TOPICS_WINDOW_DAYS", "14"))
MIN_CLUSTER_SIZE = int(os.environ.get("TOPICS_MIN_CLUSTER_SIZE", "8"))
MIN_SAMPLES = int(os.environ.get("TOPICS_MIN_SAMPLES", "3"))
PCA_DIMS = int(os.environ.get("TOPICS_PCA_DIMS", "50"))
JACCARD_THRESHOLD = float(os.environ.get("TOPICS_JACCARD_THRESHOLD", "0.3"))
EMBEDDING_DIM = 1024  # Qwen3-Embedding-0.6B (ТЗ-91)
ITEMS_BATCH = 1000    # батч-инсёрт topic_items (поштучные INSERT запрещены)


def connect() -> psycopg.Connection:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL не задан")
    conn = psycopg.connect(url)
    register_vector(conn)  # эмбеддинги приходят сразу numpy-массивами
    return conn


def to_vector(value) -> np.ndarray:
    """np.ndarray от register_vector; pgvector.Vector — через to_numpy();
    str '[0.01,-0.02,...]' — fallback-парсинг."""
    if isinstance(value, np.ndarray):
        return value.astype(np.float32)
    if hasattr(value, "to_numpy"):  # pgvector.vector.Vector (psycopg-регистрация)
        return np.asarray(value.to_numpy(), dtype=np.float32)
    if isinstance(value, (list, tuple)):
        return np.asarray(value, dtype=np.float32)
    if isinstance(value, str):
        return np.fromstring(value.strip("[]"), sep=",", dtype=np.float32)
    raise TypeError(f"неожиданный тип эмбеддинга: {type(value)!r}")


def load_news(conn: psycopg.Connection) -> list[tuple]:
    """Новости окна с эмбеддингом + московская дата для гистограммы/тренда."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text,
                   COALESCE(title_ru, '')   AS title_ru,
                   COALESCE(summary_ru, '') AS summary_ru,
                   COALESCE(source, '')     AS source,
                   (published_at AT TIME ZONE 'Europe/Moscow')::date AS msk_date,
                   embedding
            FROM news
            WHERE published_at >= now() - make_interval(days => %s)
              AND embedding IS NOT NULL
            """,
            [WINDOW_DAYS],
        )
        return cur.fetchall()


def build_matrix(rows: list[tuple]) -> np.ndarray:
    vectors = [to_vector(r[5]) for r in rows]
    X = np.vstack(vectors).astype(np.float32)
    # Обязательный probe (приёмка №2): shape матрицы до PCA — ожидание (N, 1024)
    log.info("probe: матрица эмбеддингов shape=%s (ожидание: (N, %s))", X.shape, EMBEDDING_DIM)
    if X.ndim != 2 or X.shape[1] != EMBEDDING_DIM:
        raise RuntimeError(f"неожиданный shape эмбеддингов: {X.shape}, ожидалось (N, {EMBEDDING_DIM})")
    # L2-ренормализация строк: Qwen3 нормализован, но после concat/кастинга
    # гарантируем единичные длины — тогда euclidean ~ cosine для HDBSCAN.
    norms = np.linalg.norm(X, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return (X / norms).astype(np.float32)


def run_clustering(X: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    n_components = min(PCA_DIMS, X.shape[0], X.shape[1])
    log.info("PCA: %s -> %s компонент", X.shape[1], n_components)
    X_pca = PCA(n_components=n_components).fit_transform(X).astype(np.float32)
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=MIN_CLUSTER_SIZE,
        min_samples=MIN_SAMPLES,
        metric="euclidean",
    )
    labels = clusterer.fit_predict(X_pca)
    log.info("HDBSCAN: кластеров %s, шум %s", len(set(labels) - {-1}), int(np.sum(labels == -1)))
    # is_core: в ТЗ — membership_probabilities_ >= 0.5, но в hdbscan >= 0.8.34
    # soft-матрица убрана из атрибутов fit; probabilities_ — вероятность принадлежности
    # НАЗНАЧЕННОМУ кластеру (0 у шума), для диагонали soft-матрицы эквивалентна.
    return labels, clusterer.probabilities_.astype(np.float32)


def load_prev_topics(conn: psycopg.Connection) -> dict:
    """Кластеры последнего done-прогона: topic_id -> {name, summary, news_ids}."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT t.id::text, t.name, t.summary, ti.news_id::text
            FROM topics t
            JOIN topic_items ti ON ti.topic_id = t.id
            WHERE t.run_id = (
                SELECT id FROM topic_runs
                WHERE status = 'done'
                ORDER BY finished_at DESC NULLS LAST
                LIMIT 1
            )
            """
        )
        rows = cur.fetchall()
    prev: dict = {}
    for topic_id, name, summary, news_id in rows:
        slot = prev.setdefault(topic_id, {"name": name, "summary": summary, "news": set()})
        slot["news"].add(news_id)
    return prev


def match_prev(
    clusters: dict,
    rows: list[tuple],
    prev: dict,
) -> dict:
    """Jaccard-склейка с прошлым прогоном. Возвращает label -> prev_topic_id.

    Один старый кластер наследует только один новый (максимальный overlap),
    остальные остаются новыми темами.
    """
    candidates: list[tuple] = []  # (overlap, label, prev_topic_id)
    for label, idxs in clusters.items():
        news_ids = {rows[i][0] for i in idxs}
        for prev_id, p in prev.items():
            inter = len(news_ids & p["news"])
            if inter == 0:
                continue
            overlap = inter / len(news_ids | p["news"])
            if overlap >= JACCARD_THRESHOLD:
                candidates.append((overlap, label, prev_id))
    candidates.sort(key=lambda c: -c[0])
    matched: dict = {}
    used_prev: set = set()
    for _overlap, label, prev_id in candidates:
        if label in matched or prev_id in used_prev:
            continue
        matched[label] = prev_id
        used_prev.add(prev_id)
    return matched


def top_keywords(texts: list, top_n: int = 10) -> list:
    """TF-IDF top-10 терминов по текстам кластера (title_ru || ' ' || summary_ru)."""
    docs = [t.strip() for t in texts if t and t.strip()]
    if not docs:
        return []
    try:
        vectorizer = TfidfVectorizer(max_features=2000)
        matrix = vectorizer.fit_transform(docs)
    except ValueError:
        return []
    scores = np.asarray(matrix.mean(axis=0)).ravel()
    terms = vectorizer.get_feature_names_out()
    order = scores.argsort()[::-1][:top_n]
    return [str(terms[i]) for i in order if scores[i] > 0]


def compute_trend(daily_counts: dict) -> str:
    """Сумма последних 3 ПОЛНЫХ московских дней vs предыдущие 3 (±25%).

    Неполный текущий день в сравнение не включаем.
    """
    today = datetime.now(MSK).date()
    last3 = sum(daily_counts.get(today - timedelta(days=k), 0) for k in (1, 2, 3))
    prev3 = sum(daily_counts.get(today - timedelta(days=k), 0) for k in (4, 5, 6))
    if prev3 == 0:
        return "growing" if last3 > 0 else "stable"
    ratio = last3 / prev3
    if ratio > 1.25:
        return "growing"
    if ratio < 0.75:
        return "fading"
    return "stable"


def cluster_stats(label: int, idxs: list, rows: list[tuple]) -> dict:
    dates = [rows[i][4] for i in idxs]
    daily_counts: dict = {}
    for d in dates:
        daily_counts[d] = daily_counts.get(d, 0) + 1
    daily = [{"d": d.isoformat(), "n": daily_counts[d]} for d in sorted(daily_counts)]
    texts = [(rows[i][1] + " " + rows[i][2]).strip() for i in idxs]
    return {
        "news_count": len(idxs),
        "span_days": (max(dates) - min(dates)).days + 1,
        "sources_count": len({rows[i][3] for i in idxs if rows[i][3]}),
        "trend": compute_trend(daily_counts),
        "daily": daily,
        "keywords": top_keywords(texts),
    }


def save_result(
    conn: psycopg.Connection,
    run_id: str,
    clusters: dict,
    rows: list[tuple],
    probs: np.ndarray | None,
    matched: dict,
    prev: dict,
    noise_count: int,
) -> None:
    """Запись результата ОДНОЙ транзакцией (явный commit — см. psycopg3 ниже)."""
    # psycopg3: conn.transaction() при уже открытой транзакции (SELECT из load_news)
    # создаёт SAVEPOINT, и выход из контекста НЕ коммитит внешнюю транзакцию —
    # при conn.close() в finally молча происходит ROLLBACK. Поэтому ручной commit.
    try:
        with conn.cursor() as cur:
            for label in sorted(clusters.keys()):
                idxs = clusters[label]
                stats = cluster_stats(label, idxs, rows)
                prev_id = matched.get(label)
                inherited = prev.get(prev_id) if prev_id else None
                cur.execute(
                    """
                    INSERT INTO topics (run_id, prev_topic_id, label, name, summary,
                                        named, keywords, news_count, span_days,
                                        sources_count, trend, daily)
                    VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s::jsonb)
                    RETURNING id
                    """,
                    [
                        run_id,
                        prev_id,
                        int(label),
                        inherited["name"] if inherited else None,
                        inherited["summary"] if inherited else None,
                        prev_id is not None,  # сматченные темы сразу named — LLM не дёргаем
                        json.dumps(stats["keywords"], ensure_ascii=False),
                        stats["news_count"],
                        stats["span_days"],
                        stats["sources_count"],
                        stats["trend"],
                        json.dumps(stats["daily"], ensure_ascii=False),
                    ],
                )
                topic_id = cur.fetchone()[0]
                items = [
                    (topic_id, rows[i][0], bool(probs[i] >= 0.5))  # is_core = prob >= 0.5
                    for i in idxs
                ]
                for k in range(0, len(items), ITEMS_BATCH):
                    cur.executemany(
                        "INSERT INTO topic_items (topic_id, news_id, is_core)"
                        " VALUES (%s, %s::uuid, %s)",
                        items[k : k + ITEMS_BATCH],
                    )
            cur.execute(
                """
                UPDATE topic_runs
                SET status = 'done',
                    news_count = %s,
                    topics_found = %s,
                    noise_count = %s,
                    finished_at = now()
                WHERE id = %s
                """,
                [len(rows), len(clusters), noise_count, run_id],
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def error_text(exc: BaseException, loaded: int | None) -> str:
    """Первая строка — тип исключения, далее repr() ключевых переменных (без секретов)."""
    lines = [f"{type(exc).__name__}: {exc!r}"]
    lines.append(
        f"window_days={WINDOW_DAYS!r} min_cluster_size={MIN_CLUSTER_SIZE!r} "
        f"min_samples={MIN_SAMPLES!r} pca_dims={PCA_DIMS!r} "
        f"jaccard_threshold={JACCARD_THRESHOLD!r}"
    )
    if loaded is not None:
        lines.append(f"news_loaded={loaded!r}")
    return "\n".join(lines)[:4000]


def main() -> int:
    conn = connect()
    run_id = None
    loaded = None
    try:
        params = {
            "min_cluster_size": MIN_CLUSTER_SIZE,
            "min_samples": MIN_SAMPLES,
            "pca_dims": PCA_DIMS,
            "jaccard_threshold": JACCARD_THRESHOLD,
        }
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO topic_runs (window_days, params, status)
                VALUES (%s, %s::jsonb, 'running')
                RETURNING id
                """,
                [WINDOW_DAYS, json.dumps(params)],
            )
            run_id = cur.fetchone()[0]
        conn.commit()
        log.info("прогон %s стартовал: окно %s дней, params=%s", run_id, WINDOW_DAYS, params)

        rows = load_news(conn)
        loaded = len(rows)
        log.info("загружено новостей с эмбеддингом: %s", loaded)

        clusters: dict = {}
        noise_count = 0
        if rows:
            X = build_matrix(rows)  # probe shape — внутри
            labels, probs = run_clustering(X)
            for idx, label in enumerate(labels):
                if label == -1:
                    continue
                clusters.setdefault(int(label), []).append(idx)
            noise_count = int(np.sum(labels == -1))

        prev = load_prev_topics(conn)
        matched = match_prev(clusters, rows, prev) if (clusters and prev) else {}
        if matched:
            log.info("Jaccard-склейка: %s тем унаследовали имя (порог %s)", len(matched), JACCARD_THRESHOLD)

        save_result(conn, run_id, clusters, rows, probs if rows else None, matched, prev, noise_count)
        log.info("прогон %s завершён: тем %s, шум %s", run_id, len(clusters), noise_count)
        return 0
    except Exception as exc:  # noqa: BLE001 — любое исключение = error-прогон
        log.error("прогон упал:\n%s", traceback.format_exc())
        try:
            conn.rollback()
            if run_id is not None:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE topic_runs
                        SET status = 'error', error = %s, finished_at = now()
                        WHERE id = %s
                        """,
                        [error_text(exc, loaded), run_id],
                    )
                conn.commit()
        except Exception:
            conn.rollback()
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
