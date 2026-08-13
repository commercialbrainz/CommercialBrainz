"""Enqueue and finalize media fingerprint jobs."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from uuid import UUID

from arq import create_pool
from arq.connections import RedisSettings
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.database import async_session_factory
from app.models import (
    FingerprintPhase,
    FingerprintStatus,
    MediaFingerprint,
)
from app.services.media_hash import run_fingerprint_job

logger = logging.getLogger(__name__)
settings = get_settings()


async def _get_arq_pool():
    return await create_pool(RedisSettings.from_dsn(settings.redis_url))


async def get_redis_queue_depth() -> int:
    """Number of jobs waiting in the arq Redis queue."""
    try:
        pool = await _get_arq_pool()
        try:
            return int(await pool.zcard(pool.default_queue_name) or 0)
        finally:
            await pool.aclose()
    except Exception:
        logger.exception("Failed to read Redis queue depth")
        return 0


async def enqueue_hash_job(fingerprint_id: UUID) -> None:
    try:
        pool = await _get_arq_pool()
        await pool.enqueue_job("hash_media", str(fingerprint_id))
        await pool.aclose()
    except Exception:
        logger.exception("Failed to enqueue hash job %s", fingerprint_id)


async def add_preview_fingerprint(
    db: AsyncSession, edit_id: UUID, youtube_id: str
) -> MediaFingerprint:
    """Insert a PREVIEW fingerprint on the caller's session (no commit, no enqueue).

    Must run in the same transaction as the edit insert. A background task that
    opens a second session will wait forever on the edits FK while the submit
    request is still uncommitted, which blocks the worker and leaves the edit page
    stuck on loading.
    """
    fp = MediaFingerprint(
        edit_id=edit_id,
        youtube_id=youtube_id,
        phase=FingerprintPhase.PREVIEW,
        status=FingerprintStatus.PENDING,
    )
    db.add(fp)
    await db.flush()
    return fp


async def create_preview_fingerprint(edit_id: UUID, youtube_id: str) -> MediaFingerprint:
    async with async_session_factory() as db:
        fp = await add_preview_fingerprint(db, edit_id, youtube_id)
        await db.commit()
        await db.refresh(fp)
        fingerprint_id = fp.id

    await enqueue_hash_job(fingerprint_id)
    return fp


async def reclaim_processing_fingerprints(
    *,
    older_than_minutes: int | None = None,
) -> list[UUID]:
    """
    Reset PROCESSING fingerprints to PENDING and return their IDs.

    When older_than_minutes is None, reclaim every PROCESSING row (worker restart).
    """
    async with async_session_factory() as db:
        query = select(MediaFingerprint.id).where(
            MediaFingerprint.status == FingerprintStatus.PROCESSING,
        )
        if older_than_minutes is not None:
            stale_before = datetime.now(UTC) - timedelta(minutes=older_than_minutes)
            query = query.where(MediaFingerprint.started_at < stale_before)
        result = await db.execute(query)
        stale_ids = [row[0] for row in result.all()]
        for fp_id in stale_ids:
            fp = await db.get(MediaFingerprint, fp_id)
            if not fp:
                continue
            fp.status = FingerprintStatus.PENDING
            fp.started_at = None
            fp.error_message = (
                f"Reclaimed after {older_than_minutes or 0}+ minutes in PROCESSING; will retry"
                if older_than_minutes is not None
                else "Reclaimed after worker restart; will retry"
            )[:2000]
            if fp.video_id:
                from app.models import Video, VideoHashStatus

                video = await db.get(Video, fp.video_id)
                if video:
                    video.hash_status = VideoHashStatus.PENDING
        await db.commit()
    if stale_ids:
        if older_than_minutes is not None:
            suffix = f" older than {older_than_minutes}m"
        else:
            suffix = " on startup"
        logger.info("Reclaimed %d PROCESSING fingerprint(s)%s", len(stale_ids), suffix)
    return stale_ids


async def process_pending_queue(ctx) -> int:
    """Enqueue pending fingerprint jobs and retry eligible failures (cron safety net)."""
    retry_before = datetime.now(UTC) - timedelta(minutes=settings.fingerprint_retry_delay_minutes)
    count = 0
    retry_ids: list[UUID] = []
    stale_ids = await reclaim_processing_fingerprints(
        older_than_minutes=settings.fingerprint_stale_processing_minutes,
    )
    async with async_session_factory() as db:
        result = await db.execute(
            select(MediaFingerprint.id).where(
                MediaFingerprint.status == FingerprintStatus.PENDING,
            ).order_by(MediaFingerprint.created_at).limit(20)
        )
        pending_ids = [row[0] for row in result.all()]

        failed_result = await db.execute(
            select(MediaFingerprint.id).where(
                MediaFingerprint.status == FingerprintStatus.FAILED,
                MediaFingerprint.retry_count < settings.fingerprint_max_retries,
                MediaFingerprint.completed_at.is_not(None),
                MediaFingerprint.completed_at < retry_before,
            ).order_by(MediaFingerprint.completed_at).limit(10)
        )
        failed_ids = [row[0] for row in failed_result.all()]

        for fp_id in failed_ids:
            fp = await db.get(MediaFingerprint, fp_id)
            if not fp:
                continue
            fp.status = FingerprintStatus.PENDING
            fp.started_at = None
            retry_ids.append(fp_id)
            if fp.video_id:
                from app.models import Video, VideoHashStatus

                video = await db.get(Video, fp.video_id)
                if video:
                    video.hash_status = VideoHashStatus.PENDING
        await db.commit()

    # stale_ids were already set to PENDING; skip re-enqueueing them via pending_ids
    # by using the list returned from reclaim (they may also appear in pending_ids).
    seen: set[UUID] = set()
    for fp_id in pending_ids + stale_ids + failed_ids:
        if fp_id in seen:
            continue
        seen.add(fp_id)
        await enqueue_hash_job(fp_id)
        count += 1
    if retry_ids:
        logger.info("Re-queued %d failed fingerprint job(s) for retry", len(retry_ids))
    return count


async def hash_media(ctx, fingerprint_id: str) -> str:
    await run_fingerprint_job(UUID(fingerprint_id))
    return fingerprint_id
