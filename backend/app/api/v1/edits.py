import asyncio
import logging
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.auth.deps import get_current_user_optional, require_submitter, require_write_access
from app.auth.security import user_can_vote, user_email_verified
from app.database import get_db
from app.models import Commercial, Edit, EditStatus, EditType, User, Video, VoteChoice
from app.schemas import (
    DuplicateMatchPublic,
    EditCreate,
    EditPublic,
    PaginatedResponse,
    VideoCreate,
    VoteCreate,
    VotePublic,
    YouTubeMetadataPreview,
)
from app.services import EditService
from app.services.advertisers import resolve_commercial_advertiser
from app.services.edit_response import build_edit_public
from app.services.fingerprint_queries import (
    find_all_hash_duplicates_for_fingerprint,
    get_preview_fingerprint,
)
from app.services.hash_queue import add_preview_fingerprint, enqueue_hash_job
from app.services.submission_terms import validate_and_record_terms_acceptance
from app.services.youtube_metadata import fetch_youtube_metadata
from app.utils import extract_youtube_id

router = APIRouter(prefix="/edits", tags=["edits"])
logger = logging.getLogger(__name__)


async def _schedule_hash_job(job_id: UUID) -> None:
    await enqueue_hash_job(job_id)


async def _schedule_thumbnail_job(video_id: UUID) -> None:
    from app.services.thumbnail_queue import enqueue_thumbnail_job

    await enqueue_thumbnail_job(video_id)


def _schedule_pending_hash(background_tasks: BackgroundTasks, edit: Edit) -> None:
    pending = getattr(edit, "_pending_hash_job", None)
    if pending is not None:
        background_tasks.add_task(_schedule_hash_job, pending)
    pending_thumb = getattr(edit, "_pending_thumbnail_video", None)
    if pending_thumb is not None:
        background_tasks.add_task(_schedule_thumbnail_job, pending_thumb)


@router.post("", response_model=EditPublic, status_code=status.HTTP_201_CREATED)
async def create_edit(
    data: EditCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_submitter),
):
    try:
        edit_type = EditType(data.edit_type)
    except ValueError as e:
        raise HTTPException(status_code=400, detail="Invalid edit type") from e

    try:
        edit = await EditService.create_edit(
            db,
            user,
            edit_type,
            data.entity_type,
            data.after_state,
            before_state=data.before_state,
            entity_id=data.entity_id,
            comment=data.comment,
            force_votable=data.force_votable,
        )
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    _schedule_pending_hash(background_tasks, edit)
    return await build_edit_public(db, edit, votes=[], editor_username=user.username)


@router.post("/submit-video", response_model=EditPublic, status_code=status.HTTP_201_CREATED)
async def submit_video(
    data: VideoCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_submitter),
):
    try:
        await validate_and_record_terms_acceptance(db, user, data.terms_agreed)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        youtube_id = data.youtube_id or extract_youtube_id(data.youtube_url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    if data.commercial_id and data.commercial:
        raise HTTPException(
            status_code=400,
            detail=(
                "Provide either commercial_id (add link) or commercial "
                "(new campaign), not both."
            ),
        )
    if not data.commercial_id and not data.commercial:
        raise HTTPException(
            status_code=400,
            detail="Either commercial_id or commercial metadata is required.",
        )
    if data.commercial_id:
        commercial = await db.get(Commercial, data.commercial_id)
        if not commercial:
            raise HTTPException(status_code=404, detail="Commercial not found")

    after_state = data.model_dump(
        mode="json",
        exclude={"comment", "force_votable", "commercial", "terms_agreed"},
    )
    after_state["youtube_id"] = youtube_id
    after_state["youtube_url"] = data.youtube_url

    if data.commercial:
        commercial = data.commercial.model_dump(mode="json")
        if data.commercial.products:
            commercial["products"] = data.commercial.products
        if data.commercial.advertiser_id:
            commercial["advertiser_id"] = str(data.commercial.advertiser_id)
        if data.commercial.agency_id:
            commercial["agency_id"] = str(data.commercial.agency_id)
        try:
            resolved = await resolve_commercial_advertiser(
                db,
                user,
                commercial,
                brand_comment=data.comment,
            )
            commercial = resolved.commercial
            from app.services.catalog import resolve_all_catalogs

            commercial, catalog_edits = await resolve_all_catalogs(db, user, commercial)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        after_state["commercial"] = commercial
        if resolved.brand_edit:
            after_state["brand_edit_id"] = str(resolved.brand_edit.id)
        if catalog_edits:
            after_state["catalog_edit_ids"] = [str(e.id) for e in catalog_edits]

    if data.commercial_id:
        after_state["commercial_id"] = str(data.commercial_id)

    try:
        edit = await EditService.create_edit(
            db,
            user,
            EditType.CREATE_VIDEO,
            "video",
            after_state,
            comment=data.comment,
            force_votable=data.force_votable,
        )
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    if edit.status == EditStatus.OPEN:
        # Create the preview row in this transaction, then only enqueue Redis
        # after the response. A second DB session in a background task deadlocks
        # on edits.id while this request is still uncommitted.
        fp = await add_preview_fingerprint(db, edit.id, youtube_id)
        background_tasks.add_task(_schedule_hash_job, fp.id)
    _schedule_pending_hash(background_tasks, edit)
    return await build_edit_public(db, edit, votes=[], editor_username=user.username)


@router.get("/youtube-metadata", response_model=YouTubeMetadataPreview)
async def lookup_youtube_metadata(
    url: str = Query(min_length=11, max_length=512),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_submitter),
):
    try:
        youtube_id = extract_youtube_id(url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    try:
        data = await asyncio.to_thread(fetch_youtube_metadata, url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    existing = await db.scalar(select(Video.sbid).where(Video.youtube_id == youtube_id))
    return YouTubeMetadataPreview(**data, existing_video_sbid=existing)


@router.get("/open", response_model=PaginatedResponse)
async def list_open_edits(
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=25, le=100),
    db: AsyncSession = Depends(get_db),
    user: User | None = Depends(get_current_user_optional),
):
    stmt = (
        select(Edit)
        .options(selectinload(Edit.votes), selectinload(Edit.editor))
        .where(Edit.status == EditStatus.OPEN)
        .order_by(Edit.created_at.desc())
    )
    total = await db.scalar(
        select(func.count()).select_from(Edit).where(Edit.status == EditStatus.OPEN)
    )
    result = await db.execute(stmt.offset(offset).limit(limit))
    edits = result.scalars().all()
    items = []
    for edit in edits:
        try:
            items.append((await build_edit_public(db, edit)).model_dump(mode="json"))
        except Exception:
            logger.exception("Failed to serialize open edit %s", edit.id)
            raise HTTPException(
                status_code=500,
                detail=f"Failed to load open edit {edit.id}. Check API logs.",
            ) from None
    return PaginatedResponse(items=items, total=total or 0, offset=offset, limit=limit)


@router.get("/{edit_id}/duplicates", response_model=list[DuplicateMatchPublic])
async def get_edit_duplicates(edit_id: UUID, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Edit).where(Edit.id == edit_id))
    edit = result.scalar_one_or_none()
    if not edit:
        raise HTTPException(status_code=404, detail="Edit not found")

    fp = await get_preview_fingerprint(db, edit.id)
    if not fp:
        return []

    matches = await find_all_hash_duplicates_for_fingerprint(db, fp)
    return [DuplicateMatchPublic(**match) for match in matches]


@router.get("/{edit_id}", response_model=EditPublic)
async def get_edit(edit_id: UUID, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Edit)
        .options(selectinload(Edit.votes), selectinload(Edit.editor))
        .where(Edit.id == edit_id)
    )
    edit = result.scalar_one_or_none()
    if not edit:
        raise HTTPException(status_code=404, detail="Edit not found")
    try:
        return await build_edit_public(db, edit)
    except Exception:
        logger.exception("Failed to serialize edit %s", edit.id)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to load edit {edit.id}. Check API logs.",
        ) from None


@router.post("/{edit_id}/vote", response_model=VotePublic)
async def vote_on_edit(
    edit_id: UUID,
    data: VoteCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_write_access),
):
    if not user_email_verified(user):
        raise HTTPException(status_code=403, detail="Verify your email address before voting.")
    if not user_can_vote(user):
        raise HTTPException(status_code=403, detail="Not eligible to vote yet")

    result = await db.execute(select(Edit).where(Edit.id == edit_id))
    edit = result.scalar_one_or_none()
    if not edit or edit.status != EditStatus.OPEN:
        raise HTTPException(status_code=404, detail="Open edit not found")

    if data.choice is None:
        choice = None
    else:
        try:
            choice = VoteChoice(data.choice)
        except ValueError as e:
            raise HTTPException(status_code=400, detail="Invalid vote choice") from e

    try:
        vote = await EditService.cast_vote(db, edit, user, choice, data.comment)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    _schedule_pending_hash(background_tasks, edit)

    if vote is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return VotePublic(
        id=vote.id,
        voter_id=vote.voter_id,
        choice=vote.choice.value,
        comment=vote.comment,
        created_at=vote.created_at,
    )


@router.post("/{edit_id}/cancel", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_edit(
    edit_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_write_access),
):
    result = await db.execute(select(Edit).where(Edit.id == edit_id))
    edit = result.scalar_one_or_none()
    if not edit or edit.status != EditStatus.OPEN:
        raise HTTPException(status_code=404, detail="Open edit not found")
    if edit.editor_id != user.id and user.role.value != "admin":
        raise HTTPException(status_code=403, detail="Cannot cancel this edit")
    edit.status = EditStatus.CANCELLED
    from datetime import UTC, datetime

    edit.closed_at = datetime.now(UTC)
