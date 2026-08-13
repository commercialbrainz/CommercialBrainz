"""Build EditPublic responses with optional fingerprint preview."""

from __future__ import annotations

from sqlalchemy import inspect as sa_inspect
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Edit, Vote
from app.schemas import EditPublic, FingerprintPreviewPublic, VotePublic
from app.services.fingerprint_queries import fingerprint_to_dict, get_preview_fingerprint


def _editor_username(edit: Edit) -> str | None:
    insp = sa_inspect(edit)
    if "editor" in insp.unloaded:
        return None
    editor = edit.editor
    return editor.username if editor is not None else None


def _loaded_votes(edit: Edit, votes: list[Vote] | None) -> list[Vote]:
    if votes is not None:
        return votes
    insp = sa_inspect(edit)
    if "votes" in insp.unloaded:
        return []
    return list(edit.votes)


async def build_edit_public(
    db: AsyncSession,
    edit: Edit,
    votes: list[Vote] | None = None,
    *,
    editor_username: str | None = None,
) -> EditPublic:
    vote_list = _loaded_votes(edit, votes)
    fingerprint_preview = None
    if edit.edit_type.value == "create_video":
        fp = await get_preview_fingerprint(db, edit.id)
        fp_dict = fingerprint_to_dict(fp)
        if fp_dict:
            fingerprint_preview = FingerprintPreviewPublic(**fp_dict)

    return EditPublic(
        id=edit.id,
        edit_type=edit.edit_type.value,
        status=edit.status.value,
        entity_type=edit.entity_type,
        entity_id=edit.entity_id,
        before_state=edit.before_state,
        after_state=edit.after_state,
        editor_id=edit.editor_id,
        editor_username=editor_username if editor_username is not None else _editor_username(edit),
        comment=edit.comment,
        expires_at=edit.expires_at,
        closed_at=edit.closed_at,
        created_at=edit.created_at,
        votes=[
            VotePublic(
                id=v.id,
                voter_id=v.voter_id,
                choice=v.choice.value,
                comment=v.comment,
                created_at=v.created_at,
            )
            for v in vote_list
        ],
        fingerprint_preview=fingerprint_preview,
    )
