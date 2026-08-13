import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, type CommercialDetail, type SubmissionTerms, type YouTubeMetadataPreview } from "../api";
import { useAuth, canSubmit } from "../auth";
import SubmissionTermsView from "./SubmissionTermsView";
import SubmissionGenresFields from "./SubmissionGenresFields";
import {
  RegionSelect,
  SubRegionSelect,
  regionHasSubRegionPicker,
  regionSelectionToPayload,
  subRegionFieldLabel,
  type RegionSelection,
} from "./RegionPicker";
import {
  addLinkDefaultsFromVideo,
  commercialInheritanceSummary,
  referenceVideoFromCommercial,
} from "../utils/addLinkDefaults";
import { commercialUrl } from "../utils/commercialUrls";
import { EMPTY_SUBMISSION_GENRES, submissionGenresPayload, type SubmissionGenres } from "../utils/submissionGenres";
import { extractYouTubeId } from "../utils/youtube";
import { youtubeIdThumbnail } from "../utils/videoThumbnail";
import { videoDisplayTitle } from "../utils/videoMetadata";

interface Props {
  commercial: CommercialDetail;
  onSubmitted?: () => void;
  /** When true, omit the outer card chrome (used inside a popup). */
  embedded?: boolean;
  onCancel?: () => void;
}

export default function AddCommercialLinkForm({
  commercial,
  onSubmitted,
  embedded = false,
  onCancel,
}: Props) {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [versionLabel, setVersionLabel] = useState("");
  const [comment, setComment] = useState("");
  const [language, setLanguage] = useState("");
  const [slogan, setSlogan] = useState("");
  const [transcript, setTranscript] = useState("");
  const [tags, setTags] = useState("");
  const [regionSelection, setRegionSelection] = useState<RegionSelection>({});
  const [genres, setGenres] = useState<SubmissionGenres>({ ...EMPTY_SUBMISSION_GENRES });
  const [referenceLabel, setReferenceLabel] = useState<string | null>(null);
  const [loadingDefaults, setLoadingDefaults] = useState(false);
  const [terms, setTerms] = useState<SubmissionTerms | null>(null);
  const [termsAgreed, setTermsAgreed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [ytMeta, setYtMeta] = useState<YouTubeMetadataPreview | null>(null);
  const lastFetchedId = useRef<string | null>(null);
  const inherited = commercialInheritanceSummary(commercial);

  useEffect(() => {
    api.getSubmissionTerms().then(setTerms).catch(() => setTerms(null));
  }, []);

  useEffect(() => {
    const ref = referenceVideoFromCommercial(commercial);
    if (!ref) {
      setReferenceLabel(null);
      return;
    }
    setLoadingDefaults(true);
    api
      .getVideo(ref.sbid)
      .then((full) => {
        const defaults = addLinkDefaultsFromVideo(full);
        setLanguage(defaults.language);
        setSlogan(defaults.slogan);
        setTranscript(defaults.transcript);
        setTags(defaults.tags);
        setRegionSelection(defaults.regionSelection);
        setGenres(defaults.genres);
        setReferenceLabel(videoDisplayTitle(full));
      })
      .catch(() => setReferenceLabel(ref.link_label || ref.version_label || ref.slogan || null))
      .finally(() => setLoadingDefaults(false));
  }, [commercial.sbid]);

  useEffect(() => {
    const youtubeId = extractYouTubeId(youtubeUrl);
    if (!youtubeId || !canSubmit(user)) {
      setYtMeta(null);
      lastFetchedId.current = null;
      return;
    }
    if (youtubeId === lastFetchedId.current) return;

    const timer = window.setTimeout(() => {
      api
        .fetchYouTubeMetadata(youtubeUrl)
        .then((meta) => {
          lastFetchedId.current = meta.youtube_id;
          setYtMeta(meta);
          if (meta.language) setLanguage((prev) => prev || meta.language || "");
          if (meta.transcript) setTranscript((prev) => prev || meta.transcript || "");
          if (meta.tags.length) {
            setTags((prev) => prev || meta.tags.join(", "));
          }
          if (meta.channel_name) {
            setGenres((prev) =>
              prev.target_channel.trim() ? prev : { ...prev, target_channel: meta.channel_name ?? "" }
            );
          }
        })
        .catch(() => setYtMeta(null));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [youtubeUrl, user]);

  if (!user || !canSubmit(user)) {
    return (
      <p className="muted" style={{ margin: embedded ? 0 : undefined }}>
        <Link to="/login">Log in</Link> with submit access to add another YouTube link to this
        commercial.
      </p>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!termsAgreed) {
      setError("You must agree to the Terms of Submission.");
      return;
    }
    setLoading(true);
    try {
      const edit = await api.submitVideo({
        youtube_url: youtubeUrl,
        commercial_id: commercial.sbid,
        version_label: versionLabel.trim() || undefined,
        comment: comment.trim() || undefined,
        language: language.trim() || undefined,
        slogan: slogan.trim() || undefined,
        transcript: transcript.trim() || undefined,
        tags: tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
        genres: submissionGenresPayload(genres),
        terms_agreed: true,
        ...regionSelectionToPayload(regionSelection),
        ...(ytMeta
          ? {
              channel_name: ytMeta.channel_name || undefined,
              upload_date: ytMeta.upload_date || undefined,
              duration_ms: ytMeta.duration_ms ?? undefined,
              aspect_ratio: ytMeta.aspect_ratio || undefined,
              resolution: ytMeta.resolution || undefined,
              thumbnail_url: ytMeta.thumbnail_url || undefined,
              metadata: ytMeta.metadata,
            }
          : {}),
      });
      setYoutubeUrl("");
      setVersionLabel("");
      setComment("");
      setTermsAgreed(false);
      onSubmitted?.();
      navigate(`/edits/${edit.id}`, {
        state: {
          justSubmitted: true,
          edit,
          message:
            "Submitted for community review. It will not appear in the video catalog until the edit is approved.",
        },
      });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const body = (
    <>
      {!embedded && <h3 style={{ marginTop: 0 }}>Add another YouTube link</h3>}
      <p className="muted" style={{ marginBottom: "1rem", marginTop: embedded ? 0 : undefined }}>
        Same commercial, different upload — alternate cuts, :30/:60 versions, regional copies, or
        backup mirrors. The commercial stays the same; describe what&apos;s different about this link.
      </p>

      <div
        className="card"
        style={{ marginBottom: "1rem", background: "var(--surface)", padding: "0.85rem 1rem" }}
      >
        <p style={{ margin: "0 0 0.35rem", fontWeight: 600 }}>Inherited from this commercial</p>
        <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
          {inherited.map((line) => (
            <li key={line} className="muted" style={{ fontSize: "0.9rem" }}>
              {line}
            </li>
          ))}
        </ul>
        {loadingDefaults && (
          <p className="muted" style={{ margin: "0.5rem 0 0", fontSize: "0.85rem" }}>
            Loading defaults from existing link…
          </p>
        )}
        {referenceLabel && !loadingDefaults && (
          <p className="muted" style={{ margin: "0.5rem 0 0", fontSize: "0.85rem" }}>
            Link metadata pre-filled from <strong>{referenceLabel}</strong>. Change only what
            differs for the new upload.
          </p>
        )}
      </div>

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="add-link-url">YouTube URL *</label>
          <input
            id="add-link-url"
            value={youtubeUrl}
            onChange={(e) => setYoutubeUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
            required
          />
        </div>

        {ytMeta?.existing_video_sbid && (
          <p className="error">
            This YouTube ID is already in the archive.{" "}
            <Link to={`/video/${ytMeta.existing_video_sbid}`}>View existing entry</Link>
          </p>
        )}

        {(ytMeta?.thumbnail_url || ytMeta?.youtube_id) && (
          <img
            src={ytMeta.thumbnail_url || youtubeIdThumbnail(ytMeta.youtube_id)}
            alt=""
            style={{
              width: "100%",
              maxWidth: 320,
              aspectRatio: "16 / 9",
              objectFit: "cover",
              borderRadius: "var(--radius)",
              marginBottom: "1rem",
            }}
          />
        )}

        <div className="form-group">
          <label htmlFor="add-link-version">What&apos;s different? (version label) *</label>
          <input
            id="add-link-version"
            value={versionLabel}
            onChange={(e) => setVersionLabel(e.target.value)}
            placeholder='e.g. "30-second cut", "UK version", "Backup upload", "Director&apos;s edit"'
            required
          />
          <p className="muted" style={{ marginTop: "0.35rem", fontSize: "0.85rem" }}>
            Required — helps voters tell this link apart from others on the same commercial.
          </p>
        </div>

        <details className="card" style={{ marginBottom: "1rem", padding: "0.85rem 1rem" }} open>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>
            Link-specific metadata (optional overrides)
          </summary>
          <p className="muted" style={{ margin: "0.75rem 0", fontSize: "0.85rem" }}>
            Pre-filled from an existing link. Edit fields that differ for this upload.
          </p>

          <div className="form-group">
            <label htmlFor="add-link-slogan">Slogan / tagline</label>
            <input
              id="add-link-slogan"
              value={slogan}
              onChange={(e) => setSlogan(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label htmlFor="add-link-language">Language</label>
            <input
              id="add-link-language"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder="en"
            />
          </div>
          <div className="form-group">
            <label htmlFor="add-link-region">Region</label>
            <RegionSelect value={regionSelection} onChange={setRegionSelection} />
          </div>
          {regionHasSubRegionPicker(regionSelection.region) && (
            <div className="form-group">
              <label htmlFor="add-link-sub-region">
                {subRegionFieldLabel(regionSelection.region)}
              </label>
              <SubRegionSelect value={regionSelection} onChange={setRegionSelection} />
            </div>
          )}
          <div className="form-group">
            <label htmlFor="add-link-tags">Tags (comma-separated)</label>
            <input
              id="add-link-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label htmlFor="add-link-transcript">Transcript</label>
            <textarea
              id="add-link-transcript"
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              rows={3}
            />
          </div>

          <SubmissionGenresFields value={genres} onChange={setGenres} />
        </details>

        <div className="form-group">
          <label htmlFor="add-link-comment">Comment for voters (optional)</label>
          <textarea
            id="add-link-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            placeholder="Explain why this version belongs with this commercial…"
          />
        </div>

        {terms && (
          <div style={{ marginBottom: "1rem" }}>
            <SubmissionTermsView terms={terms} />
            <label style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
              <input
                type="checkbox"
                checked={termsAgreed}
                onChange={(e) => setTermsAgreed(e.target.checked)}
              />
              <span>I agree to the Terms of Submission</span>
            </label>
          </div>
        )}

        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={loading || !!ytMeta?.existing_video_sbid || !versionLabel.trim()}
          >
            {loading ? "Submitting…" : "Submit link for review"}
          </button>
          {onCancel && (
            <button type="button" className="btn btn-secondary" disabled={loading} onClick={onCancel}>
              Cancel
            </button>
          )}
        </div>
      </form>

      {error && <p className="error">{error}</p>}

      <p className="muted" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
        Need a blank form?{" "}
        <Link to={`/submit?commercial=${encodeURIComponent(commercial.sbid)}`}>
          Open full submit page
        </Link>
        {!embedded && (
          <>
            {" · "}
            <Link to={commercialUrl(commercial.sbid)}>Back to commercial</Link>
          </>
        )}
      </p>
    </>
  );

  if (embedded) {
    return <div>{body}</div>;
  }

  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      {body}
    </div>
  );
}
