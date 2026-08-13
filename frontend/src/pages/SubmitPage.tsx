import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useAuth, canSubmit } from "../auth";
import { api, type CommercialDetail, type SubmissionTerms, type YouTubeMetadataPreview } from "../api";
import SubmissionTermsView from "../components/SubmissionTermsView";
import AdvertiserPicker, { type AdvertiserSelection } from "../components/AdvertiserPicker";
import CatalogPicker, { type CatalogSelection } from "../components/CatalogPicker";
import { CATALOG_KIND_LIST } from "../catalog/kinds";
import {
  RegionSelect,
  SubRegionSelect,
  regionHasSubRegionPicker,
  regionSelectionToPayload,
  subRegionFieldLabel,
  type RegionSelection,
} from "../components/RegionPicker";
import SubmissionGenresFields, {
  EMPTY_SUBMISSION_GENRES,
} from "../components/SubmissionGenresFields";
import type { SubmissionGenres } from "../utils/submissionGenres";
import { submissionGenresPayload } from "../utils/submissionGenres";
import { COMMERCIAL_DECADES } from "../utils/commercialPeriod";
import { COMMERCIAL_TYPES, isBumperType } from "../utils/commercialTypes";
import {
  addLinkDefaultsFromVideo,
  commercialInheritanceSummary,
  referenceVideoFromCommercial,
} from "../utils/addLinkDefaults";
import { extractYouTubeId, formatDurationMs } from "../utils/youtube";
import { youtubeIdThumbnail } from "../utils/videoThumbnail";
import { nextSlotAtPoints } from "../utils/editDisplay";

const EMPTY_FORM = {
  youtube_url: "",
  commercial_title: "",
  version_label: "",
  year: "",
  decade: "",
  commercial_type: "",
  bumper_channel: "",
  language: "",
  transcript: "",
  slogan: "",
  tags: "",
  comment: "",
};

function applyYouTubePrefill(
  prev: typeof EMPTY_FORM,
  meta: YouTubeMetadataPreview
): typeof EMPTY_FORM {
  const tagStr = meta.tags.length ? meta.tags.join(", ") : "";
  return {
    ...prev,
    commercial_title: prev.commercial_title || meta.title || "",
    language: prev.language || meta.language || "",
    tags: prev.tags || tagStr,
    transcript: prev.transcript || meta.transcript || "",
    comment: prev.comment || meta.suggested_comment || "",
  };
}

async function suggestAdvertiserFromChannel(
  channel: string
): Promise<AdvertiserSelection> {
  const trimmed = channel.trim();
  if (!trimmed) return {};
  try {
    const matches = await api.searchAdvertisers(trimmed);
    const exact = matches.find((m) => m.title.toLowerCase() === trimmed.toLowerCase());
    if (exact) {
      return { advertiser_id: exact.sbid, advertiser_name: exact.title };
    }
    const partial = matches.find((m) =>
      m.title.toLowerCase().includes(trimmed.toLowerCase())
    );
    if (partial) {
      return { advertiser_id: partial.sbid, advertiser_name: partial.title };
    }
  } catch {
    /* ignore lookup errors */
  }
  return { advertiser_name: trimmed };
}

export default function SubmitPage() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const addLinkCommercialId = searchParams.get("commercial");
  const [addLinkCommercial, setAddLinkCommercial] = useState<CommercialDetail | null>(null);
  const [addLinkDefaultsLoading, setAddLinkDefaultsLoading] = useState(false);
  const [addLinkReferenceLabel, setAddLinkReferenceLabel] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [terms, setTerms] = useState<SubmissionTerms | null>(null);
  const [termsAgreed, setTermsAgreed] = useState(false);
  const [termsLoading, setTermsLoading] = useState(true);

  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [genres, setGenres] = useState<SubmissionGenres>({ ...EMPTY_SUBMISSION_GENRES });

  const [advertiser, setAdvertiser] = useState<AdvertiserSelection>({});
  const [catalogSelections, setCatalogSelections] = useState<
    Record<string, CatalogSelection>
  >({
    store: {},
    service: {},
    event: {},
    holiday: {},
  });
  const [regionSelection, setRegionSelection] = useState<RegionSelection>({});
  const [ytMeta, setYtMeta] = useState<YouTubeMetadataPreview | null>(null);
  const [ytLoading, setYtLoading] = useState(false);
  const [ytError, setYtError] = useState("");
  const lastFetchedId = useRef<string | null>(null);
  const advertiserTouched = useRef(false);

  useEffect(() => {
    if (!addLinkCommercialId) {
      setAddLinkCommercial(null);
      setAddLinkReferenceLabel(null);
      return;
    }
    setAddLinkDefaultsLoading(true);
    api
      .getCommercial(addLinkCommercialId)
      .then(async (commercial) => {
        setAddLinkCommercial(commercial);
        setForm((prev) => ({
          ...prev,
          commercial_title: commercial.title,
        }));
        const ref = referenceVideoFromCommercial(commercial);
        if (!ref) {
          setAddLinkReferenceLabel(null);
          return;
        }
        try {
          const full = await api.getVideo(ref.sbid);
          const defaults = addLinkDefaultsFromVideo(full);
          setForm((prev) => ({
            ...prev,
            language: defaults.language,
            slogan: defaults.slogan,
            transcript: defaults.transcript,
            tags: defaults.tags,
          }));
          setRegionSelection(defaults.regionSelection);
          setGenres(defaults.genres);
          setAddLinkReferenceLabel(
            full.link_label || full.version_label || full.slogan || "main link"
          );
        } catch {
          setAddLinkReferenceLabel(ref.link_label || ref.version_label || ref.slogan || null);
        }
      })
      .catch(() => {
        setAddLinkCommercial(null);
        setAddLinkReferenceLabel(null);
      })
      .finally(() => setAddLinkDefaultsLoading(false));
  }, [addLinkCommercialId]);

  useEffect(() => {
    const youtubeId = extractYouTubeId(form.youtube_url);
    if (!youtubeId) {
      setYtMeta(null);
      setYtError("");
      setYtLoading(false);
      lastFetchedId.current = null;
      return;
    }
    if (youtubeId === lastFetchedId.current) return;

    setYtLoading(true);
    setYtError("");

    const timer = window.setTimeout(() => {
      api
        .fetchYouTubeMetadata(form.youtube_url)
        .then(async (meta) => {
          lastFetchedId.current = meta.youtube_id;
          setYtMeta(meta);
          setForm((prev) => applyYouTubePrefill(prev, meta));
          if (!advertiserTouched.current && meta.channel_name) {
            const suggestion = await suggestAdvertiserFromChannel(meta.channel_name);
            if (!advertiserTouched.current) {
              setAdvertiser(suggestion);
            }
          }
          if (meta.channel_name) {
            setGenres((prev) =>
              prev.target_channel.trim()
                ? prev
                : { ...prev, target_channel: meta.channel_name ?? "" }
            );
          }
        })
        .catch((err) => {
          lastFetchedId.current = null;
          setYtMeta(null);
          setYtError((err as Error).message);
        })
        .finally(() => setYtLoading(false));
    }, 600);

    return () => window.clearTimeout(timer);
  }, [form.youtube_url]);

  useEffect(() => {
    if (user?.can_submit) {
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh slot counts when opening submit
  }, [user?.id, user?.can_submit]);

  useEffect(() => {
    if (!user || !canSubmit(user)) {
      setTermsLoading(false);
      return;
    }
    api
      .getSubmissionTerms()
      .then(setTerms)
      .catch((err) => setError((err as Error).message))
      .finally(() => setTermsLoading(false));
  }, [user]);

  if (!user) {
    return (
      <div className="card">
        <p>You must <a href="/login">log in</a> to submit commercials.</p>
      </div>
    );
  }

  if (!canSubmit(user)) {
    return (
      <div className="card">
        <h2 className="page-title">Submit access required</h2>
        <p>
          Your account can vote on edits but cannot submit links yet. Complete the{" "}
          <a href="/submit/upgrade">submission terms quiz</a> to upgrade to a submit &amp; vote account.
        </p>
      </div>
    );
  }

  const termsOutdated =
    terms != null &&
    (user.submission_terms_version == null || user.submission_terms_version < terms.version);

  const atSlotCap = user.submit_slots_available <= 0;
  const nextSlot = nextSlotAtPoints(user.reputation_points);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!termsAgreed) {
      setError("You must agree to the Terms of Submission.");
      return;
    }
    if (
      !addLinkCommercial &&
      isBumperType(form.commercial_type) &&
      !form.bumper_channel.trim()
    ) {
      setError("Channel is required when type is Bumper.");
      return;
    }
    setLoading(true);
    try {
      const shared = {
        youtube_url: form.youtube_url,
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
        language: form.language || ytMeta?.language || undefined,
        ...regionSelectionToPayload(regionSelection),
        transcript: form.transcript || undefined,
        slogan: form.slogan || undefined,
        tags: form.tags ? form.tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
        genres: submissionGenresPayload(genres),
        comment: form.comment || undefined,
        terms_agreed: true,
      };

      const edit = await api.submitVideo(
        addLinkCommercial
          ? {
              ...shared,
              commercial_id: addLinkCommercial.sbid,
              version_label: form.version_label.trim() || undefined,
            }
          : {
              ...shared,
              commercial: {
                title: form.commercial_title,
                ...(advertiser.advertiser_id
                  ? { advertiser_id: advertiser.advertiser_id }
                  : advertiser.advertiser_name
                    ? { advertiser_name: advertiser.advertiser_name }
                    : {}),
                ...(() => {
                  const entries: [string, string][] = [];
                  for (const kind of CATALOG_KIND_LIST) {
                    const sel = catalogSelections[kind.key] ?? {};
                    if (sel.id) entries.push([kind.idKey, sel.id]);
                    else if (sel.name) entries.push([kind.nameKey, sel.name]);
                  }
                  return Object.fromEntries(entries);
                })(),
                year: form.year ? parseInt(form.year, 10) : undefined,
                decade: form.decade ? parseInt(form.decade, 10) : undefined,
                ...(form.commercial_type
                  ? {
                      commercial_type: form.commercial_type,
                      ...(isBumperType(form.commercial_type)
                        ? { bumper_channel: form.bumper_channel.trim() }
                        : {}),
                    }
                  : {}),
              },
            }
      );
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

  return (
    <div style={{ maxWidth: 760 }}>
      <div className="flex-between" style={{ alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
        <h1 className="page-title" style={{ margin: 0 }}>
          {addLinkCommercial ? "Add link to commercial" : "Submit Commercial Video"}
        </h1>
        {user && (user.bulk_submit_enabled || user.can_bulk_submit) && (
          <Link to="/submit/bulk" className="btn btn-secondary">
            Playlist import
          </Link>
        )}
      </div>
      <p className="muted" style={{ marginBottom: "1rem", marginTop: "1rem" }}>
        {addLinkCommercial ? (
          <>
            Adding a YouTube link to{" "}
            <Link to={`/commercial/${addLinkCommercial.sbid}`}>{addLinkCommercial.title}</Link>. Same
            commercial — only fill in what differs for this upload. The link enters the edit queue for
            approval, then community votes pick the main link.
          </>
        ) : (
          "Submissions enter the edit queue for community voting. Review the terms before submitting."
        )}
      </p>

      {addLinkCommercial && (
        <div className="card" style={{ marginBottom: "1.5rem", padding: "0.85rem 1rem" }}>
          <p style={{ margin: "0 0 0.35rem", fontWeight: 600 }}>Inherited from this commercial</p>
          <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {commercialInheritanceSummary(addLinkCommercial).map((line) => (
              <li key={line} className="muted" style={{ fontSize: "0.9rem" }}>
                {line}
              </li>
            ))}
          </ul>
          {addLinkDefaultsLoading && (
            <p className="muted" style={{ margin: "0.5rem 0 0", fontSize: "0.85rem" }}>
              Loading defaults from existing link…
            </p>
          )}
          {addLinkReferenceLabel && !addLinkDefaultsLoading && (
            <p className="muted" style={{ margin: "0.5rem 0 0", fontSize: "0.85rem" }}>
              Link metadata pre-filled from <strong>{addLinkReferenceLabel}</strong>. Change only what
              differs for the new upload.
            </p>
          )}
        </div>
      )}

      <div className="card" style={{ marginBottom: "1.5rem" }}>
        <p style={{ margin: 0 }}>
          <strong>Submit slots:</strong> {user.submit_slots_used} / {user.submit_slots_max} in use
          {" · "}
          <strong>{user.reputation_points.toFixed(2)}</strong> reputation pts
        </p>
        {nextSlot != null && (
          <p className="muted" style={{ margin: "0.5rem 0 0" }}>
            Next slot unlocks at {nextSlot} points (earn +0.25 per approval, like, quality, or version
            when your submission is approved).
          </p>
        )}
        {atSlotCap && (
          <p className="error" style={{ margin: "0.5rem 0 0" }}>
            All submit slots are in use. Wait for open submissions to close or earn more reputation.
          </p>
        )}
      </div>

      {termsLoading && <p className="muted">Loading terms...</p>}

      {terms && (
        <details className="card terms-card" style={{ marginBottom: "1.5rem" }} open={termsOutdated}>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>
            Terms of Submission (v{terms.version})
          </summary>
          <div style={{ marginTop: "1rem" }}>
            <SubmissionTermsView terms={terms} compact />
          </div>
        </details>
      )}

      {termsOutdated && (
        <p className="error" style={{ marginBottom: "1rem" }}>
          The submission terms have been updated. Please review and agree before submitting.
        </p>
      )}

      <form onSubmit={handleSubmit} className="card">
        <div className="form-group">
          <label>YouTube URL *</label>
          <input
            required
            value={form.youtube_url}
            onChange={(e) => {
              const youtube_url = e.target.value;
              setForm((prev) => ({ ...prev, youtube_url }));
              if (!extractYouTubeId(youtube_url)) {
                lastFetchedId.current = null;
                setYtMeta(null);
                setYtError("");
              }
            }}
            placeholder="https://www.youtube.com/watch?v=..."
          />
          {ytError && !ytLoading && (
            <p className="error" style={{ marginTop: "0.5rem", fontSize: "0.85rem" }}>
              {ytError}
            </p>
          )}
          {ytMeta && !ytLoading && (
            <div style={{ marginTop: "0.75rem" }}>
              {(ytMeta.thumbnail_url || ytMeta.youtube_id) && (
                <img
                  src={ytMeta.thumbnail_url || youtubeIdThumbnail(ytMeta.youtube_id)}
                  alt=""
                  style={{
                    width: "100%",
                    maxHeight: 280,
                    objectFit: "cover",
                    borderRadius: 4,
                    marginBottom: "0.75rem",
                  }}
                />
              )}
              <div
                style={{
                  position: "relative",
                  paddingBottom: "56.25%",
                  height: 0,
                  overflow: "hidden",
                  borderRadius: 4,
                  background: "#000",
                }}
              >
                <iframe
                  title="YouTube preview"
                  src={`https://www.youtube-nocookie.com/embed/${ytMeta.youtube_id}`}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: "100%",
                    border: 0,
                  }}
                />
              </div>
              <div className="card" style={{ marginTop: "0.75rem", padding: "0.75rem" }}>
                <p style={{ margin: 0, fontWeight: 600 }}>
                  {ytMeta.title}
                  {ytMeta.is_short && (
                    <span className="muted" style={{ marginLeft: "0.5rem", fontSize: "0.85rem" }}>
                      Short
                    </span>
                  )}
                </p>
                {ytMeta.channel_name && (
                  <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
                    {ytMeta.channel_name}
                    {ytMeta.duration_ms ? ` · ${formatDurationMs(ytMeta.duration_ms)}` : ""}
                    {ytMeta.resolution ? ` · ${ytMeta.resolution}` : ""}
                    {ytMeta.aspect_ratio ? ` · ${ytMeta.aspect_ratio}` : ""}
                    {ytMeta.upload_date ? ` · uploaded ${ytMeta.upload_date}` : ""}
                  </p>
                )}
                <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.85rem" }}>
                  Pulled title, language, tags, captions, channel, and video details from YouTube.
                </p>
                {ytMeta.existing_video_sbid && (
                  <p className="error" style={{ margin: "0.35rem 0 0", fontSize: "0.85rem" }}>
                    This video is already in the database —{" "}
                    <Link to={`/video/${ytMeta.existing_video_sbid}`}>view existing entry</Link>.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
        {addLinkCommercial && (
          <div className="form-group">
            <label>What&apos;s different? (version label) *</label>
            <input
              required
              value={form.version_label}
              onChange={(e) => setForm({ ...form, version_label: e.target.value })}
              placeholder='e.g. "30s cut", "Director&apos;s edit", "Backup mirror"'
            />
          </div>
        )}
        {!addLinkCommercial && (
          <>
        <div className="form-group">
          <label>Commercial Title *</label>
          <input
            required
            value={form.commercial_title}
            onChange={(e) => setForm({ ...form, commercial_title: e.target.value })}
          />
        </div>
        <div className="form-group">
          <label>Advertiser / Brand</label>
          <AdvertiserPicker
            value={advertiser}
            onChange={(next) => {
              advertiserTouched.current = true;
              setAdvertiser(next);
            }}
          />
          <p className="muted" style={{ marginTop: "0.35rem", fontSize: "0.85rem" }}>
            Search an existing brand or enter a new one. New brands are shared for all submitters.
          </p>
        </div>
        {CATALOG_KIND_LIST.map((kind) => (
          <div className="form-group" key={kind.key}>
            <label>{kind.label}</label>
            <CatalogPicker
              kind={kind}
              value={catalogSelections[kind.key] ?? {}}
              onChange={(next) =>
                setCatalogSelections((prev) => ({ ...prev, [kind.key]: next }))
              }
            />
            <p className="muted" style={{ marginTop: "0.35rem", fontSize: "0.85rem" }}>
              Optional. Link an existing {kind.label.toLowerCase()} or propose a new one.
            </p>
          </div>
        ))}
        <div className="form-group">
          <label>Type of commercial</label>
          <select
            value={form.commercial_type}
            onChange={(e) =>
              setForm({
                ...form,
                commercial_type: e.target.value,
                ...(e.target.value === "bumper" ? {} : { bumper_channel: "" }),
              })
            }
          >
            <option value="">Unknown / not sure</option>
            {COMMERCIAL_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        {isBumperType(form.commercial_type) && (
          <div className="form-group">
            <label>Channel *</label>
            <input
              required
              value={form.bumper_channel}
              onChange={(e) => setForm({ ...form, bumper_channel: e.target.value })}
              placeholder="e.g. Cartoon Network, Nickelodeon"
            />
            <p className="muted" style={{ marginTop: "0.35rem", fontSize: "0.85rem" }}>
              Which channel this bumper is for.
            </p>
          </div>
        )}
        <div className="form-group">
          <label>Decade aired (rough estimate)</label>
          <select
            value={form.decade}
            onChange={(e) => setForm({ ...form, decade: e.target.value })}
          >
            <option value="">Unknown / not sure</option>
            {COMMERCIAL_DECADES.map((d) => (
              <option key={d} value={d}>
                {d}s
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>Exact year (if known)</label>
          <input
            type="number"
            min={1900}
            max={2100}
            value={form.year}
            onChange={(e) => setForm({ ...form, year: e.target.value })}
            placeholder="e.g. 1997"
          />
        </div>
          </>
        )}
        <div className="form-group">
          <label>Language</label>
          <input
            value={form.language}
            onChange={(e) => setForm({ ...form, language: e.target.value })}
            placeholder="en"
          />
        </div>
        <div className="form-group">
          <label htmlFor="region-select">Region</label>
          <RegionSelect value={regionSelection} onChange={setRegionSelection} />
        </div>
        {regionHasSubRegionPicker(regionSelection.region) && (
          <div className="form-group">
            <label htmlFor="sub-region-select">
              {subRegionFieldLabel(regionSelection.region)}
            </label>
            <SubRegionSelect value={regionSelection} onChange={setRegionSelection} />
          </div>
        )}
        <div className="form-group">
          <label>Slogan</label>
          <input
            value={form.slogan}
            onChange={(e) => setForm({ ...form, slogan: e.target.value })}
          />
        </div>
        <div className="form-group">
          <label>Transcript</label>
          <textarea
            value={form.transcript}
            onChange={(e) => setForm({ ...form, transcript: e.target.value })}
          />
        </div>
        <div className="form-group">
          <label>Tags (comma-separated)</label>
          <input
            value={form.tags}
            onChange={(e) => setForm({ ...form, tags: e.target.value })}
            placeholder="superbowl, automotive, humor"
          />
        </div>

        <SubmissionGenresFields value={genres} onChange={setGenres} />

        <div className="form-group">
          <label>Edit comment</label>
          <textarea
            value={form.comment}
            onChange={(e) => setForm({ ...form, comment: e.target.value })}
            placeholder="Source, context, version label, or notes for voters..."
          />
        </div>

        <label style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", marginBottom: "1rem" }}>
          <input
            type="checkbox"
            checked={termsAgreed}
            onChange={(e) => setTermsAgreed(e.target.checked)}
            style={{ marginTop: "0.25rem" }}
          />
          <span>
            I have read and agree to the{" "}
            <strong>Terms of Submission</strong>
            {terms ? ` (version ${terms.version})` : ""}.
          </span>
        </label>

        {error && <p className="error">{error}</p>}
        <button
          type="submit"
          className="btn btn-primary"
          disabled={
            loading ||
            !termsAgreed ||
            atSlotCap ||
            (addLinkCommercial != null && !form.version_label.trim())
          }
        >
          {loading ? "Submitting..." : "Submit for review"}
        </button>
      </form>

      {ytLoading && (
        <div className="wait-overlay" role="dialog" aria-modal="true" aria-live="polite">
          <div className="wait-overlay-card">
            <p className="wait-overlay-title">Please wait</p>
            <p className="muted">Fetching YouTube metadata…</p>
          </div>
        </div>
      )}
    </div>
  );
}
