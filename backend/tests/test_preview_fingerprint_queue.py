"""Preview fingerprints must be inserted on the submit session, not a later one."""

from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest

from app.models import FingerprintPhase, FingerprintStatus
from app.services.hash_queue import add_preview_fingerprint


@pytest.mark.asyncio
async def test_add_preview_fingerprint_uses_caller_session():
    db = MagicMock()
    db.add = MagicMock()
    db.flush = AsyncMock()
    edit_id = uuid4()

    fp = await add_preview_fingerprint(db, edit_id, "dQw4w9wgGcQ")

    db.add.assert_called_once_with(fp)
    db.flush.assert_awaited_once()
    db.commit.assert_not_called()
    assert fp.edit_id == edit_id
    assert fp.youtube_id == "dQw4w9wgGcQ"
    assert fp.phase == FingerprintPhase.PREVIEW
    assert fp.status == FingerprintStatus.PENDING
